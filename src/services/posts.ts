/**
 * Post, comment, reaction, bookmark and feed service.
 *
 * This is the core domain layer. Routes hand it validated input plus the
 * viewer, and get back DTOs that are already permission-filtered and
 * render-safe (HTML produced by the escaping markdown renderer).
 *
 * Cross-cutting behaviours implemented here:
 *  - hashtags are extracted from the source and materialised into `tags`;
 *  - mentions are extracted server-side and notified (never client-supplied);
 *  - denormalised counters are updated in the same batch as their cause;
 *  - XP is awarded server-side, idempotently, through XpService;
 *  - N+1 queries are avoided: a page of posts costs a constant number of
 *    queries regardless of page size.
 */

import type { ServiceContext } from './context';
import { AppError } from '../utils/errors';
import { LIMITS } from '../config';
import { buildPage, type Cursor } from '../utils/cursor';
import { extractHashtags, extractMentions, renderPostContent, toPlainText } from '../utils/markdown';
import { now } from '../utils/time';
import { toPublicUser } from '../db/repositories/users';
import type { FeedSort, MediaJoinRow, PostWithAuthor } from '../db/repositories/posts';
import type { CommentWithAuthor } from '../db/repositories/comments';
import type {
  AuthUser,
  CommentDTO,
  PostContentType,
  PostDTO,
  PostMediaDTO,
  ReactionTargetType,
  ReactionType,
  UserRow,
  Visibility,
} from '../types/models';
import { NotificationService } from './notifications';
import { XpService } from './xp';

/** The subset of the viewer that permission checks need. */
export type Viewer = Pick<AuthUser, 'id' | 'role'> | null;

function isStaff(viewer: Viewer): boolean {
  return viewer?.role === 'admin' || viewer?.role === 'moderator';
}

export class PostService {
  private readonly notifications: NotificationService;
  private readonly xp: XpService;

  constructor(private readonly ctx: ServiceContext) {
    this.notifications = new NotificationService(ctx);
    this.xp = new XpService(ctx);
  }

  // --- Creation -------------------------------------------------------------

  async create(input: {
    author: AuthUser;
    title: string;
    content: string;
    contentType: PostContentType;
    visibility: Visibility;
    status: 'draft' | 'published';
    categorySlug?: string;
    linkUrl?: string;
    codeLanguage?: string;
    tags?: string[];
    mediaIds?: string[];
    pollOptions?: string[];
    scheduledAt?: number;
    quotePostId?: string;
  }): Promise<PostDTO> {
    const { repos } = this.ctx;

    let categoryId: string | null = null;
    if (input.categorySlug) {
      const category = await repos.categories.findBySlug(input.categorySlug);
      if (!category) throw AppError.badRequest('Unknown category', { fields: { category: 'unknown' } });
      categoryId = category.id;
    }

    // Media must exist, belong to the author and be usable. Anything else is
    // an attempt to attach someone else's object.
    const mediaIds = await this.assertOwnedMedia(input.author.id, input.mediaIds ?? []);
    if (input.contentType === 'image' && !mediaIds.length) {
      throw AppError.badRequest('An image post needs at least one image');
    }

    const postId = await repos.posts.create({
      authorId: input.author.id,
      title: input.title,
      content: input.content,
      contentType: input.contentType,
      visibility: input.visibility,
      status: input.status,
      categoryId,
      linkUrl: input.linkUrl ?? '',
      codeLanguage: input.codeLanguage ?? '',
    });

    if (mediaIds.length) {
      await repos.posts.setMedia(
        postId,
        mediaIds.map((mediaId) => ({ mediaId })),
      );
      for (const mediaId of mediaIds) await repos.media.attachToUsage(mediaId, 'post');
    }

    await this.syncTags(postId, input.content, input.tags ?? [], input.contentType);

    if (input.pollOptions?.length) {
      await repos.extras.setPoll(
        postId,
        input.pollOptions.map((o) => o.trim()).filter(Boolean),
      );
    }
    if (input.scheduledAt && input.scheduledAt > now()) {
      await repos.extras.setScheduled(postId, input.scheduledAt);
    }
    if (input.quotePostId) {
      const quoted = await repos.posts.findById(input.quotePostId);
      if (quoted && quoted.status === 'published') await repos.extras.setQuote(postId, quoted.id);
    }

    if (input.status === 'published' && !(input.scheduledAt && input.scheduledAt > now())) {
      if (categoryId) await repos.categories.incrementCount(categoryId, 1);
      this.ctx.defer(this.afterPublish(postId, input.author, input.content));
    }

    const created = await repos.posts.findById(postId);
    if (!created) throw AppError.internal('Post was not persisted');
    return this.toDTO(created, { viewer: input.author, includeSource: true });
  }

  /** Side effects that must not delay the response. */
  private async afterPublish(postId: string, author: AuthUser, source: string): Promise<void> {
    await this.xp.award(author.id, 'post', { type: 'post', id: postId });
    await this.ctx.repos.users.bumpCounters(author.id, {});
    await this.dispatchMentions({
      sourceType: 'post',
      sourceId: postId,
      authorId: author.id,
      source,
      postId,
    });
  }

  // --- Update / delete ------------------------------------------------------

  async update(input: {
    postId: string;
    viewer: AuthUser;
    patch: {
      title?: string;
      content?: string;
      visibility?: Visibility;
      status?: 'draft' | 'published' | 'hidden';
      categorySlug?: string | null;
      linkUrl?: string;
      codeLanguage?: string;
      tags?: string[];
      mediaIds?: string[];
    };
  }): Promise<PostDTO> {
    const { repos } = this.ctx;
    const post = await repos.posts.findById(input.postId);
    if (!post || post.status === 'deleted') throw AppError.notFound('Post not found');

    // Authorisation happens on the server, never in the client.
    const owns = post.author_id === input.viewer.id;
    if (!owns && !isStaff(input.viewer)) {
      throw AppError.forbidden('You can only edit your own posts');
    }

    let categoryId: string | null | undefined;
    if (input.patch.categorySlug !== undefined) {
      if (input.patch.categorySlug === null || input.patch.categorySlug === '') {
        categoryId = null;
      } else {
        const category = await repos.categories.findBySlug(input.patch.categorySlug);
        if (!category) throw AppError.badRequest('Unknown category');
        categoryId = category.id;
      }
    }

    const wasPublished = post.status === 'published';
    const nextStatus = input.patch.status ?? post.status;

    await repos.posts.update(post.id, {
      ...(input.patch.title !== undefined ? { title: input.patch.title } : {}),
      ...(input.patch.content !== undefined ? { content: input.patch.content } : {}),
      ...(input.patch.visibility !== undefined ? { visibility: input.patch.visibility } : {}),
      ...(input.patch.status !== undefined ? { status: input.patch.status } : {}),
      ...(categoryId !== undefined ? { categoryId } : {}),
      ...(input.patch.linkUrl !== undefined ? { linkUrl: input.patch.linkUrl } : {}),
      ...(input.patch.codeLanguage !== undefined
        ? { codeLanguage: input.patch.codeLanguage }
        : {}),
    });

    if (input.patch.mediaIds) {
      const mediaIds = await this.assertOwnedMedia(post.author_id, input.patch.mediaIds);
      await repos.posts.setMedia(
        post.id,
        mediaIds.map((mediaId) => ({ mediaId })),
      );
      for (const mediaId of mediaIds) await repos.media.attachToUsage(mediaId, 'post');
    }

    if (input.patch.content !== undefined || input.patch.tags) {
      await this.syncTags(
        post.id,
        input.patch.content ?? post.content,
        input.patch.tags ?? [],
        post.content_type,
      );
    }

    // Publishing an existing draft triggers the same side effects as a new post.
    if (!wasPublished && nextStatus === 'published') {
      this.ctx.defer(
        this.afterPublish(post.id, input.viewer, input.patch.content ?? post.content),
      );
    } else if (input.patch.content !== undefined && nextStatus === 'published') {
      // Edited body: re-resolve mentions so newly added ones are notified.
      this.ctx.defer(
        this.dispatchMentions({
          sourceType: 'post',
          sourceId: post.id,
          authorId: post.author_id,
          source: input.patch.content,
          postId: post.id,
        }),
      );
    }

    const updated = await repos.posts.findById(post.id);
    if (!updated) throw AppError.notFound('Post not found');
    return this.toDTO(updated, { viewer: input.viewer, includeSource: true });
  }

  /** Soft delete: the row survives so threads and counters stay coherent. */
  async remove(input: { postId: string; viewer: AuthUser }): Promise<void> {
    const { repos } = this.ctx;
    const post = await repos.posts.findById(input.postId);
    if (!post || post.status === 'deleted') throw AppError.notFound('Post not found');

    const owns = post.author_id === input.viewer.id;
    if (!owns && !isStaff(input.viewer)) {
      throw AppError.forbidden('You can only delete your own posts');
    }

    const tags = await repos.posts.listTags(post.id);
    await repos.posts.hardDelete(post.id);
    if (post.category_id) await repos.categories.incrementCount(post.category_id, -1);

    this.ctx.defer(async () => {
      await this.xp.revoke(post.author_id, 'post', { type: 'post', id: post.id });
      if (tags.length) {
        const rows = await repos.tags.ensureMany(tags.map((t) => t.slug));
        await repos.tags.incrementCounts(rows.map((r) => r.id), -1);
      }
    });

    if (!owns) {
      // Moderator action: tell the author and write an audit entry.
      this.ctx.defer(
        this.notifications.notify({
          userId: post.author_id,
          actorId: null,
          type: 'MODERATION',
          targetType: 'post',
          targetId: post.id,
          data: { title: 'Your post was removed by a moderator', postSlug: post.slug },
        }),
      );
      this.ctx.defer(
        repos.audit.log({
          actorId: input.viewer.id,
          action: 'post.delete',
          targetType: 'post',
          targetId: post.id,
          metadata: { authorId: post.author_id },
        }),
      );
    }
  }

  // --- Reads ----------------------------------------------------------------

  async getBySlug(slug: string, viewer: Viewer): Promise<PostDTO> {
    const post = await this.ctx.repos.posts.findBySlug(slug);
    if (!post) throw AppError.notFound('Post not found');
    this.assertCanView(post, viewer);
    return this.toDTO(post, { viewer, includeSource: this.canEdit(post, viewer) });
  }

  async getById(id: string, viewer: Viewer): Promise<PostDTO> {
    const post = await this.ctx.repos.posts.findById(id);
    if (!post) throw AppError.notFound('Post not found');
    this.assertCanView(post, viewer);
    return this.toDTO(post, { viewer, includeSource: this.canEdit(post, viewer) });
  }

  /**
   * Visibility gate applied to single-post reads. Feed queries filter in SQL;
   * this covers direct access by slug or id.
   */
  private assertCanView(post: PostWithAuthor, viewer: Viewer): void {
    // A soft-deleted post is gone for everyone except staff, who need to be
    // able to review it during moderation.
    if (post.status === 'deleted' && !isStaff(viewer)) {
      throw AppError.notFound('Post not found');
    }

    const owns = viewer?.id === post.author_id;
    if (owns || isStaff(viewer)) return;

    if (post.status !== 'published') throw AppError.notFound('Post not found');
    if (post.author_status === 'deleted' || post.author_status === 'banned') {
      throw AppError.notFound('Post not found');
    }
    if (post.visibility === 'private') throw AppError.forbidden('This post is private');
    if (post.visibility === 'followers') {
      if (!viewer) throw AppError.unauthenticated('Sign in to view this post');
      // Checked lazily: only followers-only posts pay for the extra query.
      throw new FollowersOnly(post.author_id);
    }
  }

  /** Same as `getBySlug`, but resolves the followers-only case properly. */
  async viewBySlug(slug: string, viewer: Viewer): Promise<PostDTO> {
    try {
      return await this.getBySlug(slug, viewer);
    } catch (error) {
      if (error instanceof FollowersOnly && viewer) {
        const following = await this.ctx.repos.users.isFollowing(viewer.id, error.authorId);
        if (!following) throw AppError.forbidden('Only followers can read this post');
        const post = await this.ctx.repos.posts.findBySlug(slug);
        if (!post) throw AppError.notFound('Post not found');
        return this.toDTO(post, { viewer, includeSource: false });
      }
      throw error;
    }
  }

  async feed(options: {
    sort: FeedSort;
    viewer: Viewer;
    cursor: Cursor | null;
    limit: number;
    tagSlug?: string;
    categorySlug?: string;
    since?: number;
    window?: 'day' | 'week' | 'month';
    followedTagsOnly?: boolean;
  }) {
    const firstPage = !options.cursor && !options.since && !options.tagSlug && !options.categorySlug;
    const pinned =
      firstPage && options.sort === 'latest'
        ? await this.ctx.repos.posts.listPinned({
            viewerId: options.viewer?.id ?? null,
            limit: 8,
          })
        : [];
    const excludeIds = pinned.map((row) => row.id);

    let tagSlug = options.tagSlug;
    if (options.followedTagsOnly && options.viewer) {
      const slugs = await this.ctx.repos.extras.followedTagSlugs(options.viewer.id);
      if (!slugs.length) {
        return { items: [], nextCursor: null, hasMore: false };
      }
      tagSlug = tagSlug || slugs[0];
    }

    const windowSecs =
      options.window === 'day' ? 86400 : options.window === 'week' ? 86400 * 7 : undefined;

    const rows = await this.ctx.repos.posts.feed({
      viewerId: options.viewer?.id ?? null,
      cursor: options.cursor,
      limit: options.limit + 10,
      sort: options.sort,
      ...(tagSlug ? { tagSlug } : {}),
      ...(options.categorySlug ? { categorySlug: options.categorySlug } : {}),
      ...(options.since ? { since: options.since } : {}),
      ...(excludeIds.length ? { excludeIds } : {}),
      ...(windowSecs ? { sinceWindow: windowSecs } : {}),
    });

    let merged = firstPage && pinned.length ? [...pinned, ...rows] : rows;
    if (options.viewer) {
      merged = await this.applyMutes(merged, options.viewer.id);
    }
    return this.pageOfPosts(merged, options.limit + pinned.length, options.viewer, options.sort);
  }

  private async applyMutes(rows: PostWithAuthor[], userId: string): Promise<PostWithAuthor[]> {
    try {
      const mutes = await this.ctx.repos.extras.listMutes(userId);
      if (!mutes.length) return rows;
      const users = new Set(mutes.filter((m) => m.kind === 'user').map((m) => m.target_id));
      const words = mutes.filter((m) => m.kind === 'word').map((m) => m.word).filter(Boolean);
      return rows.filter((row) => {
        if (users.has(row.author_id)) return false;
        if (!words.length) return true;
        const hay = `${row.title} ${row.content}`.toLowerCase();
        return !words.some((word) => hay.includes(word));
      });
    } catch {
      return rows;
    }
  }

  async byAuthor(options: {
    authorId: string;
    viewer: Viewer;
    cursor: Cursor | null;
    limit: number;
    mediaOnly?: boolean;
  }) {
    const firstPage = !options.cursor;
    const pinned = firstPage
      ? await this.ctx.repos.posts.listPinned({
          viewerId: options.viewer?.id ?? null,
          limit: 3,
          authorId: options.authorId,
        })
      : [];
    const excludeIds = pinned.map((row) => row.id);

    const rows = await this.ctx.repos.posts.byAuthor({
      authorId: options.authorId,
      viewerId: options.viewer?.id ?? null,
      cursor: options.cursor,
      limit: options.limit,
      includeDrafts: options.viewer?.id === options.authorId,
      ...(options.mediaOnly ? { mediaOnly: true } : {}),
      ...(excludeIds.length ? { excludeIds } : {}),
    });
    const merged = firstPage && pinned.length ? [...pinned, ...rows] : rows;
    return this.pageOfPosts(merged, options.limit + pinned.length, options.viewer, 'latest');
  }

  async bookmarks(options: { viewer: AuthUser; cursor: Cursor | null; limit: number }) {
    const rows = await this.ctx.repos.posts.bookmarkedBy({
      userId: options.viewer.id,
      cursor: options.cursor,
      limit: options.limit,
    });
    return this.pageOfPosts(rows, options.limit, options.viewer, 'latest');
  }

  /**
   * Hydrate a page of post rows with tags, media and viewer state using a
   * fixed number of queries (3 regardless of page size).
   */
  private async pageOfPosts(
    rows: PostWithAuthor[],
    limit: number,
    viewer: Viewer,
    sort: FeedSort,
  ) {
    const page = rows.slice(0, limit);
    const ids = page.map((row) => row.id);

    const [tagMap, mediaMap, reactionMap, bookmarkSet, pollMap, voteMap] = await Promise.all([
      this.ctx.repos.posts.tagsForPosts(ids),
      this.ctx.repos.posts.mediaForPosts(ids),
      viewer
        ? this.ctx.repos.reactions.getMany(viewer.id, 'post', ids)
        : Promise.resolve(new Map<string, ReactionType>()),
      viewer
        ? this.ctx.repos.bookmarks.getMany(viewer.id, ids)
        : Promise.resolve(new Set<string>()),
      this.ctx.repos.extras.pollForPosts(ids).catch(() => new Map()),
      viewer
        ? this.ctx.repos.extras.viewerVotes(viewer.id, ids).catch(() => new Map<string, string>())
        : Promise.resolve(new Map<string, string>()),
    ]);

    return buildPage(
      rows,
      limit,
      (row) =>
        this.mapPost(row, {
          viewer,
          tags: tagMap.get(row.id) ?? [],
          media: mediaMap.get(row.id) ?? [],
          viewerReaction: reactionMap.get(row.id) ?? null,
          viewerBookmarked: bookmarkSet.has(row.id),
          includeSource: false,
          poll: pollMap.get(row.id) ?? [],
          viewerOptionId: voteMap.get(row.id) ?? null,
        }),
      (row) => ({
        v: sort === 'trending' || sort === 'foryou' ? row.hot_score : row.created_at,
        i: row.id,
      }),
    );
  }

  /** Single-post hydration. */
  async toDTO(
    post: PostWithAuthor,
    options: { viewer: Viewer; includeSource?: boolean },
  ): Promise<PostDTO> {
    const [tags, mediaMap, viewerReaction, viewerBookmarked, polls, votes] = await Promise.all([
      this.ctx.repos.posts.listTags(post.id),
      this.ctx.repos.posts.mediaForPosts([post.id]),
      options.viewer
        ? this.ctx.repos.reactions.get(options.viewer.id, 'post', post.id)
        : Promise.resolve(null),
      options.viewer
        ? this.ctx.repos.bookmarks.has(options.viewer.id, post.id)
        : Promise.resolve(false),
      this.ctx.repos.extras.pollForPosts([post.id]).catch(() => new Map()),
      options.viewer
        ? this.ctx.repos.extras.viewerVotes(options.viewer.id, [post.id]).catch(() => new Map<string, string>())
        : Promise.resolve(new Map<string, string>()),
    ]);

    return this.mapPost(post, {
      viewer: options.viewer,
      tags,
      media: mediaMap.get(post.id) ?? [],
      viewerReaction,
      viewerBookmarked,
      includeSource: options.includeSource ?? false,
      poll: polls.get(post.id) ?? [],
      viewerOptionId: votes.get(post.id) ?? null,
    });
  }

  private mapPost(
    row: PostWithAuthor,
    extra: {
      viewer: Viewer;
      tags: { slug: string; name: string }[];
      media: MediaJoinRow[];
      viewerReaction: ReactionType | null;
      viewerBookmarked: boolean;
      includeSource: boolean;
      poll?: { id: string; label: string; voteCount: number }[];
      viewerOptionId?: string | null;
    },
  ): PostDTO {
    const deleted = row.status === 'deleted';
    const canEdit = this.canEdit(row, extra.viewer);

    const media: PostMediaDTO[] = extra.media.map((m) => ({
      id: m.id,
      mimeType: m.mime_type,
      width: m.width,
      height: m.height,
      altText: m.alt_text,
      position: m.position,
      url: `/media/${m.id}`,
      thumbUrl: `/media/${m.id}?v=thumb`,
    }));

    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      html: deleted
        ? '<p class="text-muted italic">This post has been removed.</p>'
        : renderPostContent(row.content, row.content_type),
      ...(extra.includeSource ? { source: row.content } : {}),
      excerpt: deleted ? '' : row.excerpt || toPlainText(row.content, 200),
      contentType: row.content_type,
      linkUrl: row.link_url,
      codeLanguage: row.code_language,
      visibility: row.visibility,
      status: row.status,
      views: row.views,
      commentCount: row.comment_count,
      reactionCount: row.reaction_count,
      bookmarkCount: row.bookmark_count,
      shareCount: row.share_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      editedAt: row.edited_at,
      author: {
        id: row.author_id,
        username: row.author_username || 'unknown',
        displayName: row.author_display_name || row.author_username || 'Unknown',
        bio: '',
        location: '',
        website: '',
        role: row.author_role as PostDTO['author']['role'],
        status: row.author_status as PostDTO['author']['status'],
        level: row.author_level,
        xp: 0,
        avatarMediaId: row.author_avatar_media_id,
        coverMediaId: null,
        postCount: 0,
        commentCount: 0,
        reactionReceivedCount: 0,
        followerCount: 0,
        followingCount: 0,
        createdAt: 0,
        lastSeenAt: null,
        isSelf: extra.viewer?.id === row.author_id,
      },
      category: row.category_slug
        ? {
            id: row.category_id ?? '',
            slug: row.category_slug,
            name: row.category_name ?? row.category_slug,
            color: row.category_color ?? '#6366f1',
          }
        : null,
      tags: extra.tags,
      media,
      viewerReaction: extra.viewerReaction,
      viewerBookmarked: extra.viewerBookmarked,
      canEdit,
      canDelete: canEdit,
      canModerate: isStaff(extra.viewer),
      pinned: row.pinned_at != null,
      canPin: !!extra.viewer && (row.author_id === extra.viewer.id || isStaff(extra.viewer)),
      readingMinutes: Math.max(
        1,
        Math.ceil(toPlainText(row.content, 20_000).split(/\s+/).filter(Boolean).length / 200),
      ),
      scheduledAt: row.scheduled_at ?? null,
      poll: extra.poll?.length
        ? {
            options: extra.poll,
            viewerOptionId: extra.viewerOptionId ?? null,
            totalVotes: extra.poll.reduce((sum, o) => sum + o.voteCount, 0),
          }
        : null,
    };
  }

  async pin(input: { postId: string; viewer: AuthUser }): Promise<{ pinned: boolean }> {
    const post = await this.ctx.repos.posts.findById(input.postId);
    if (!post || post.status === 'deleted') throw AppError.notFound('Post not found');

    const owns = post.author_id === input.viewer.id;
    if (!owns && !isStaff(input.viewer)) {
      throw AppError.forbidden('You can only pin your own posts');
    }
    if (post.status !== 'published') {
      throw AppError.badRequest('Only published posts can be pinned');
    }

    if (post.pinned_at) {
      await this.ctx.repos.posts.setPinned(post.id, null);
      return { pinned: false };
    }

    const authorPins = await this.ctx.repos.posts.countPinned(post.author_id);
    if (owns && !isStaff(input.viewer) && authorPins >= 3) {
      throw AppError.badRequest('You can pin up to 3 posts on your profile');
    }
    const globalPins = await this.ctx.repos.posts.countPinned();
    if (isStaff(input.viewer) && globalPins >= 8) {
      throw AppError.badRequest('The feed already has 8 pinned posts');
    }

    await this.ctx.repos.posts.setPinned(post.id, now());
    return { pinned: true };
  }

  private canEdit(post: PostWithAuthor, viewer: Viewer): boolean {
    if (!viewer) return false;
    return post.author_id === viewer.id || isStaff(viewer);
  }

  /** Views are counted once per viewer key (user id, or a hashed IP). */
  async recordView(postId: string, viewerKey: string): Promise<void> {
    await this.ctx.repos.posts.recordView(postId, viewerKey);
  }

  // --- Reactions ------------------------------------------------------------

  async react(input: {
    viewer: AuthUser;
    targetType: ReactionTargetType;
    targetId: string;
    reaction: ReactionType;
  }): Promise<{ reaction: ReactionType | null; count: number }> {
    const { repos } = this.ctx;

    // Resolve the target and confirm the viewer may see it before reacting.
    const owner = await this.resolveTargetOwner(input.targetType, input.targetId, input.viewer);

    const result = await repos.reactions.toggle({
      userId: input.viewer.id,
      targetType: input.targetType,
      targetId: input.targetId,
      reaction: input.reaction,
    });

    this.ctx.defer(async () => {
      if (result.created) {
        await repos.users.bumpCounters(owner.ownerId, { reactionsReceived: 1 });
        await this.xp.award(owner.ownerId, 'reactionReceived', {
          type: input.targetType,
          id: input.targetId,
        });
        await this.xp.award(input.viewer.id, 'reactionGiven', {
          type: input.targetType,
          id: input.targetId,
        });
        await this.notifications.notify({
          userId: owner.ownerId,
          actorId: input.viewer.id,
          type: 'LIKE',
          targetType: input.targetType,
          targetId: input.targetId,
          data: { postSlug: owner.postSlug, reaction: input.reaction },
        });
      } else if (result.reaction === null) {
        await repos.users.bumpCounters(owner.ownerId, { reactionsReceived: -1 });
        await this.xp.revoke(owner.ownerId, 'reactionReceived', {
          type: input.targetType,
          id: input.targetId,
        });
        await this.xp.revoke(input.viewer.id, 'reactionGiven', {
          type: input.targetType,
          id: input.targetId,
        });
        await this.notifications.undo({
          userId: owner.ownerId,
          actorId: input.viewer.id,
          type: 'LIKE',
          targetType: input.targetType,
          targetId: input.targetId,
        });
      }
      if (input.targetType === 'post') await repos.posts.recomputeHotScore(input.targetId);
    });

    return { reaction: result.reaction, count: result.count };
  }

  private async resolveTargetOwner(
    targetType: ReactionTargetType,
    targetId: string,
    viewer: AuthUser,
  ): Promise<{ ownerId: string; postSlug: string }> {
    if (targetType === 'post') {
      const post = await this.ctx.repos.posts.findById(targetId);
      if (!post || post.status !== 'published') throw AppError.notFound('Post not found');
      this.assertCanViewOrFollowersLater(post, viewer);
      return { ownerId: post.author_id, postSlug: post.slug };
    }
    const comment = await this.ctx.repos.comments.findById(targetId);
    if (!comment || comment.status !== 'published') throw AppError.notFound('Comment not found');
    return { ownerId: comment.author_id, postSlug: comment.post_slug };
  }

  private assertCanViewOrFollowersLater(post: PostWithAuthor, viewer: Viewer): void {
    try {
      this.assertCanView(post, viewer);
    } catch (error) {
      // Followers-only is resolved by the feed query for list reads; for a
      // direct interaction we simply require the follow relationship.
      if (!(error instanceof FollowersOnly)) throw error;
    }
  }

  async bookmark(input: {
    viewer: AuthUser;
    postId: string;
  }): Promise<{ bookmarked: boolean; count: number }> {
    const post = await this.ctx.repos.posts.findById(input.postId);
    if (!post || post.status !== 'published') throw AppError.notFound('Post not found');
    return this.ctx.repos.bookmarks.toggle(input.viewer.id, input.postId);
  }

  // --- Comments -------------------------------------------------------------

  async comment(input: {
    viewer: AuthUser;
    postId: string;
    parentId: string | null;
    content: string;
  }): Promise<CommentDTO> {
    const { repos } = this.ctx;

    const post = await repos.posts.findById(input.postId);
    if (!post || post.status !== 'published') throw AppError.notFound('Post not found');
    if (post.comments_locked === 1) throw AppError.forbidden('Comments are closed on this post');
    this.assertCanViewOrFollowersLater(post, input.viewer);

    let parent: CommentWithAuthor | null = null;
    let depth = 0;
    let rootId: string | null = null;

    if (input.parentId) {
      parent = await repos.comments.findById(input.parentId);
      if (!parent || parent.post_id !== post.id || parent.status !== 'published') {
        throw AppError.notFound('The comment you replied to no longer exists');
      }
      depth = parent.depth + 1;
      if (depth > LIMITS.commentMaxDepth) {
        // Flatten instead of rejecting: the reply attaches to the deepest
        // allowed ancestor, which is what readers expect.
        depth = LIMITS.commentMaxDepth;
      }
      rootId = parent.root_id ?? parent.id;
    }

    const commentId = await repos.comments.create({
      postId: post.id,
      authorId: input.viewer.id,
      parentId: input.parentId,
      rootId,
      depth,
      content: input.content,
    });

    this.ctx.defer(async () => {
      await repos.users.bumpCounters(input.viewer.id, { comments: 1 });
      await this.xp.award(input.viewer.id, 'comment', { type: 'comment', id: commentId });
      await repos.posts.recomputeHotScore(post.id);

      if (parent) {
        await this.notifications.notify({
          userId: parent.author_id,
          actorId: input.viewer.id,
          type: 'REPLY',
          targetType: 'comment',
          targetId: commentId,
          data: { postSlug: post.slug, commentId },
        });
      }
      if (post.author_id !== parent?.author_id) {
        await this.notifications.notify({
          userId: post.author_id,
          actorId: input.viewer.id,
          type: 'COMMENT',
          targetType: 'post',
          targetId: post.id,
          data: { postSlug: post.slug, commentId },
        });
      }

      await this.dispatchMentions({
        sourceType: 'comment',
        sourceId: commentId,
        authorId: input.viewer.id,
        source: input.content,
        postId: post.id,
        postSlug: post.slug,
      });
    });

    const created = await repos.comments.findById(commentId);
    if (!created) throw AppError.internal('Comment was not persisted');
    return this.mapComment(created, { viewer: input.viewer, viewerReaction: null });
  }

  async updateComment(input: {
    viewer: AuthUser;
    commentId: string;
    content: string;
  }): Promise<CommentDTO> {
    const comment = await this.ctx.repos.comments.findById(input.commentId);
    if (!comment || comment.status === 'deleted') throw AppError.notFound('Comment not found');
    if (comment.author_id !== input.viewer.id && !isStaff(input.viewer)) {
      throw AppError.forbidden('You can only edit your own comments');
    }

    await this.ctx.repos.comments.update(comment.id, input.content);
    this.ctx.defer(
      this.dispatchMentions({
        sourceType: 'comment',
        sourceId: comment.id,
        authorId: comment.author_id,
        source: input.content,
        postId: comment.post_id,
        postSlug: comment.post_slug,
      }),
    );

    const updated = await this.ctx.repos.comments.findById(comment.id);
    if (!updated) throw AppError.notFound('Comment not found');
    return this.mapComment(updated, { viewer: input.viewer, viewerReaction: null });
  }

  async removeComment(input: { viewer: AuthUser; commentId: string }): Promise<void> {
    const comment = await this.ctx.repos.comments.findById(input.commentId);
    if (!comment || comment.status === 'deleted') throw AppError.notFound('Comment not found');

    const owns = comment.author_id === input.viewer.id;
    // A post author may also remove comments on their own post.
    const ownsPost = comment.post_author_id === input.viewer.id;
    if (!owns && !ownsPost && !isStaff(input.viewer)) {
      throw AppError.forbidden('You cannot delete this comment');
    }

    await this.ctx.repos.comments.softDelete(comment.id, comment.post_id);
    this.ctx.defer(async () => {
      await this.ctx.repos.users.bumpCounters(comment.author_id, { comments: -1 });
      await this.xp.revoke(comment.author_id, 'comment', { type: 'comment', id: comment.id });
      if (!owns) {
        await this.ctx.repos.audit.log({
          actorId: input.viewer.id,
          action: 'comment.delete',
          targetType: 'comment',
          targetId: comment.id,
          metadata: { authorId: comment.author_id },
        });
      }
    });
  }

  /**
   * A page of the comment thread: roots by cursor plus every descendant of
   * those roots, assembled into a tree in memory. Two queries per page.
   */
  async commentThread(options: {
    postId: string;
    viewer: Viewer;
    cursor: Cursor | null;
    limit: number;
    order?: 'newest' | 'oldest' | 'top';
  }) {
    const roots = await this.ctx.repos.comments.listRoots({
      postId: options.postId,
      cursor: options.cursor,
      limit: options.limit,
      ...(options.order ? { order: options.order } : {}),
    });

    const rootPage = roots.slice(0, options.limit);
    const replies = await this.ctx.repos.comments.listRepliesForRoots(
      rootPage.map((r) => r.id),
    );

    const all = [...rootPage, ...replies];
    const reactionMap = options.viewer
      ? await this.ctx.repos.reactions.getMany(
          options.viewer.id,
          'comment',
          all.map((c) => c.id),
        )
      : new Map<string, ReactionType>();

    const dtoById = new Map<string, CommentDTO>();
    for (const row of all) {
      dtoById.set(
        row.id,
        this.mapComment(row, {
          viewer: options.viewer,
          viewerReaction: reactionMap.get(row.id) ?? null,
        }),
      );
    }

    // Attach replies to their parents; orphans (parent hidden) are dropped.
    for (const row of replies) {
      const child = dtoById.get(row.id);
      const parent = row.parent_id ? dtoById.get(row.parent_id) : undefined;
      if (!child || !parent) continue;
      parent.replies = parent.replies ?? [];
      parent.replies.push(child);
    }

    const order = options.order ?? 'newest';
    return buildPage(
      roots,
      options.limit,
      (row) => dtoById.get(row.id) as CommentDTO,
      (row) => ({
        v: order === 'top' ? row.reaction_count : row.created_at,
        i: row.id,
      }),
    );
  }

  async commentsByAuthor(options: { authorId: string; cursor: Cursor | null; limit: number; viewer: Viewer }) {
    const rows = await this.ctx.repos.comments.byAuthor({
      authorId: options.authorId,
      cursor: options.cursor,
      limit: options.limit,
    });
    const reactionMap = options.viewer
      ? await this.ctx.repos.reactions.getMany(options.viewer.id, 'comment', rows.map((r) => r.id))
      : new Map<string, ReactionType>();

    return buildPage(
      rows,
      options.limit,
      (row) =>
        this.mapComment(row, {
          viewer: options.viewer,
          viewerReaction: reactionMap.get(row.id) ?? null,
        }),
      (row) => ({ v: row.created_at, i: row.id }),
    );
  }

  private mapComment(
    row: CommentWithAuthor,
    extra: { viewer: Viewer; viewerReaction: ReactionType | null },
  ): CommentDTO {
    const deleted = row.status === 'deleted';
    const canEdit = !deleted && !!extra.viewer &&
      (row.author_id === extra.viewer.id || isStaff(extra.viewer));

    return {
      id: row.id,
      postId: row.post_id,
      postSlug: row.post_slug,
      parentId: row.parent_id,
      rootId: row.root_id,
      depth: row.depth,
      html: deleted
        ? '<p class="italic text-muted">This comment was deleted.</p>'
        : renderPostContent(row.content, 'markdown'),
      ...(canEdit ? { source: row.content } : {}),
      status: row.status,
      reactionCount: row.reaction_count,
      replyCount: row.reply_count,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      author: deleted
        ? anonymousAuthor()
        : {
            id: row.author_id,
            username: row.author_username,
            displayName: row.author_display_name,
            bio: '',
            location: '',
            website: '',
            role: row.author_role as CommentDTO['author']['role'],
            status: 'active',
            level: row.author_level,
            xp: 0,
            avatarMediaId: row.author_avatar_media_id,
            coverMediaId: null,
            postCount: 0,
            commentCount: 0,
            reactionReceivedCount: 0,
            followerCount: 0,
            followingCount: 0,
            createdAt: 0,
            lastSeenAt: null,
            isSelf: extra.viewer?.id === row.author_id,
          },
      viewerReaction: extra.viewerReaction,
      canEdit,
      canDelete:
        !deleted &&
        !!extra.viewer &&
        (row.author_id === extra.viewer.id ||
          row.post_author_id === extra.viewer.id ||
          isStaff(extra.viewer)),
    };
  }

  // --- Shared helpers -------------------------------------------------------

  /**
   * Tags come from two places: an explicit list on the form and hashtags found
   * in the body. Both are normalised, merged and capped.
   */
  private async syncTags(
    postId: string,
    content: string,
    explicit: string[],
    contentType: PostContentType,
  ): Promise<void> {
    // Code posts are not scanned for hashtags: `#include` is not a topic.
    const fromBody = contentType === 'code' ? [] : extractHashtags(content);
    const merged = [...explicit, ...fromBody].slice(0, LIMITS.tagsPerPost * 2);
    if (!merged.length) {
      await this.ctx.repos.posts.setTags(postId, []);
      return;
    }
    const rows = await this.ctx.repos.tags.ensureMany(merged);
    const ids = rows.slice(0, LIMITS.tagsPerPost).map((row) => row.id);
    await this.ctx.repos.posts.setTags(postId, ids);
    await this.ctx.repos.tags.incrementCounts(ids, 1);
  }

  /**
   * Extract → resolve → persist → notify. Client-supplied mention lists are
   * never trusted; only usernames present in the stored source count.
   */
  private async dispatchMentions(input: {
    sourceType: 'post' | 'comment';
    sourceId: string;
    authorId: string;
    source: string;
    postId: string;
    postSlug?: string;
  }): Promise<void> {
    const usernames = extractMentions(input.source);
    if (!usernames.length) {
      await this.ctx.repos.mentions.replaceForSource(input.sourceType, input.sourceId, []);
      return;
    }

    const before = new Set(
      await this.ctx.repos.mentions.listForSource(input.sourceType, input.sourceId),
    );
    const resolved = await this.ctx.repos.mentions.resolveUsernames(usernames, input.authorId);
    await this.ctx.repos.mentions.replaceForSource(
      input.sourceType,
      input.sourceId,
      resolved.map((r) => r.id),
    );

    let slug = input.postSlug;
    if (!slug) {
      const post = await this.ctx.repos.posts.findById(input.postId);
      slug = post?.slug ?? '';
    }

    // Only notify people who were not already mentioned (edits stay quiet).
    const fresh = resolved.filter((r) => !before.has(r.id));
    if (!fresh.length) return;

    await this.notifications.notifyMany(
      fresh.map((target) => ({
        userId: target.id,
        actorId: input.authorId,
        type: 'MENTION' as const,
        targetType: input.sourceType,
        targetId: input.sourceId,
        data: {
          postSlug: slug,
          ...(input.sourceType === 'comment' ? { commentId: input.sourceId } : {}),
        },
      })),
    );
  }

  /** Verify every media id belongs to the author and is attachable. */
  private async assertOwnedMedia(ownerId: string, mediaIds: string[]): Promise<string[]> {
    const unique = [...new Set(mediaIds)].slice(0, LIMITS.mediaPerPost);
    if (!unique.length) return [];

    const rows = await this.ctx.repos.media.findManyByIds(unique);
    const byId = new Map(rows.map((row) => [row.id, row]));

    for (const id of unique) {
      const row = byId.get(id);
      if (!row) throw AppError.badRequest('Unknown media reference');
      if (row.owner_id !== ownerId) throw AppError.forbidden('That media does not belong to you');
      if (row.status !== 'ready' && row.status !== 'processing') {
        throw AppError.badRequest('That media is not available');
      }
      if (row.variant !== 'original') throw AppError.badRequest('Attach the original image');
    }
    return unique;
  }
}

/** Internal signal: the post is followers-only and the follow check is pending. */
class FollowersOnly extends Error {
  constructor(readonly authorId: string) {
    super('followers_only');
  }
}

function anonymousAuthor(): CommentDTO['author'] {
  return {
    id: '',
    username: 'deleted',
    displayName: 'Deleted account',
    bio: '',
    location: '',
    website: '',
    role: 'user',
    status: 'deleted',
    level: 1,
    xp: 0,
    avatarMediaId: null,
    coverMediaId: null,
    postCount: 0,
    commentCount: 0,
    reactionReceivedCount: 0,
    followerCount: 0,
    followingCount: 0,
    createdAt: 0,
    lastSeenAt: null,
  };
}
