/**
 * Post repository.
 *
 * Feed queries are the hot path. They are written to hit the partial indexes
 * declared in migration 0003 and always use keyset (cursor) pagination:
 *   WHERE (sort_key < ?) OR (sort_key = ? AND id < ?)
 * so page N costs the same as page 1.
 */

import { Db, placeholders } from '../client';
import type { PostRow, Visibility, PostStatus, PostContentType } from '../../types/models';
import { newId, uniqueSlug } from '../../utils/id';
import { now, hotScore } from '../../utils/time';
import { toPlainText } from '../../utils/markdown';
import type { Cursor } from '../../utils/cursor';

export interface PostWithAuthor extends PostRow {
  author_username: string;
  author_display_name: string;
  author_avatar_media_id: string | null;
  author_role: string;
  author_level: number;
  author_status: string;
  category_slug: string | null;
  category_name: string | null;
  category_color: string | null;
}

const POST_SELECT = `
  p.*,
  u.username           AS author_username,
  u.display_name       AS author_display_name,
  u.avatar_media_id    AS author_avatar_media_id,
  u.role               AS author_role,
  u.level              AS author_level,
  u.status             AS author_status,
  c.slug               AS category_slug,
  c.name               AS category_name,
  c.color              AS category_color
`;

const POST_JOINS = `
  FROM posts p
  LEFT JOIN users u ON u.id = p.author_id
  LEFT JOIN categories c ON c.id = p.category_id
`;

export type FeedSort = 'latest' | 'trending' | 'foryou' | 'following';

export interface FeedOptions {
  viewerId: string | null;
  cursor: Cursor | null;
  limit: number;
  sort: FeedSort;
  categorySlug?: string;
  tagSlug?: string;
  authorId?: string;
  /** Only posts newer than this unix timestamp (used for live "new posts" polls). */
  since?: number;
  excludeIds?: string[];
  sinceWindow?: number;
}

export class PostRepository {
  constructor(private readonly db: Db) {}

  async findById(id: string): Promise<PostWithAuthor | null> {
    return this.db.first<PostWithAuthor>(
      `SELECT ${POST_SELECT} ${POST_JOINS} WHERE p.id = ?`,
      [id],
    );
  }

  async findBySlug(slug: string): Promise<PostWithAuthor | null> {
    return this.db.first<PostWithAuthor>(
      `SELECT ${POST_SELECT} ${POST_JOINS} WHERE p.slug = ?`,
      [slug],
    );
  }

  async create(input: {
    authorId: string;
    title: string;
    content: string;
    contentType: PostContentType;
    visibility: Visibility;
    status: PostStatus;
    categoryId: string | null;
    linkUrl: string;
    codeLanguage: string;
  }): Promise<string> {
    const id = newId('pst');
    const ts = now();
    const slug = uniqueSlug(input.title || toPlainText(input.content, 50) || 'post');
    const excerpt = toPlainText(input.content, 200);

    await this.db.run(
      `INSERT INTO posts
         (id, author_id, category_id, title, slug, content, excerpt, content_type,
          link_url, code_language, visibility, status, hot_score, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.authorId,
        input.categoryId,
        input.title,
        slug,
        input.content,
        excerpt,
        input.contentType,
        input.linkUrl,
        input.codeLanguage,
        input.visibility,
        input.status,
        hotScore(0, 0, 0, ts),
        ts,
        ts,
      ],
    );
    return id;
  }

  async update(
    id: string,
    patch: Partial<{
      title: string;
      content: string;
      visibility: Visibility;
      status: PostStatus;
      categoryId: string | null;
      linkUrl: string;
      codeLanguage: string;
    }>,
  ): Promise<void> {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];

    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(patch.title);
    }
    if (patch.content !== undefined) {
      sets.push('content = ?', 'excerpt = ?');
      params.push(patch.content, toPlainText(patch.content, 200));
    }
    if (patch.visibility !== undefined) {
      sets.push('visibility = ?');
      params.push(patch.visibility);
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.categoryId !== undefined) {
      sets.push('category_id = ?');
      params.push(patch.categoryId);
    }
    if (patch.linkUrl !== undefined) {
      sets.push('link_url = ?');
      params.push(patch.linkUrl);
    }
    if (patch.codeLanguage !== undefined) {
      sets.push('code_language = ?');
      params.push(patch.codeLanguage);
    }
    if (!sets.length) return;

    const ts = now();
    sets.push('updated_at = ?', 'edited_at = ?');
    params.push(ts, ts, id);
    await this.db.run(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  async setStatus(id: string, status: PostStatus): Promise<void> {
    await this.db.run('UPDATE posts SET status = ?, updated_at = ? WHERE id = ?', [
      status,
      now(),
      id,
    ]);
  }

  async hardDelete(id: string): Promise<void> {
    await this.db.run('DELETE FROM posts WHERE id = ?', [id]);
  }

  async setPinned(id: string, pinnedAt: number | null): Promise<void> {
    await this.db.run('UPDATE posts SET pinned_at = ?, updated_at = ? WHERE id = ?', [
      pinnedAt,
      now(),
      id,
    ]);
  }

  async countPinned(authorId?: string): Promise<number> {
    if (authorId) {
      return (
        (await this.db.scalar<number>(
          `SELECT COUNT(*) FROM posts WHERE author_id = ? AND pinned_at IS NOT NULL AND status = 'published'`,
          [authorId],
        )) ?? 0
      );
    }
    return (
      (await this.db.scalar<number>(
        `SELECT COUNT(*) FROM posts WHERE pinned_at IS NOT NULL AND status = 'published' AND visibility = 'public'`,
      )) ?? 0
    );
  }

  async listPinned(options: {
    viewerId: string | null;
    limit: number;
    authorId?: string;
  }): Promise<PostWithAuthor[]> {
    const where: string[] = [`u.status = 'active'`, 'p.pinned_at IS NOT NULL', `p.status = 'published'`];
    const params: (string | number)[] = [];

    const visibility = this.visibilityClause(options.viewerId);
    where.push(visibility.sql);
    params.push(...visibility.params);

    if (options.authorId) {
      where.push('p.author_id = ?');
      params.push(options.authorId);
    }

    return this.db.all<PostWithAuthor>(
      `SELECT ${POST_SELECT} ${POST_JOINS}
       WHERE ${where.join(' AND ')}
       ORDER BY p.pinned_at DESC, p.id DESC
       LIMIT ?`,
      [...params, options.limit],
    );
  }

  // --- Feeds ----------------------------------------------------------------

  /**
   * Build the visibility predicate for the viewer.
   * A viewer sees: public posts, their own posts (any visibility), and
   * followers-only posts by people they follow. Blocked users are excluded.
   */
  private publicPostSql(): string {
    return `(
      COALESCE(p.status, 'published') IN ('published', '')
      AND COALESCE(p.visibility, 'public') IN ('public', '')
    )`;
  }

  private visibilityClause(viewerId: string | null): { sql: string; params: (string | number)[] } {
    const publicPost = this.publicPostSql();
    if (!viewerId) {
      return { sql: publicPost, params: [] };
    }
    return {
      sql: `(
        p.author_id = ?
        OR (
          (
            ${publicPost}
            OR (
              p.status = 'published'
              AND p.visibility = 'followers'
              AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.following_id = p.author_id)
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
            WHERE (b.blocker_id = ? AND b.blocked_id = p.author_id)
               OR (b.blocker_id = p.author_id AND b.blocked_id = ?)
          )
        )
      )`,
      params: [viewerId, viewerId, viewerId, viewerId],
    };
  }

  async feed(options: FeedOptions): Promise<PostWithAuthor[]> {
    const { viewerId, cursor, limit, sort } = options;
    const where: string[] = [`(u.id IS NULL OR COALESCE(u.status, 'active') NOT IN ('deleted', 'banned'))`];
    const params: (string | number)[] = [];

    const visibility = this.visibilityClause(viewerId);
    where.push(visibility.sql);
    params.push(...visibility.params);

    // Only the author sees their own drafts inside a feed.
    if (viewerId) where.push(`(COALESCE(p.status, 'published') IN ('published', '') OR p.author_id = ?)`);
    if (viewerId) params.push(viewerId);

    let joins = POST_JOINS;

    if (options.tagSlug) {
      joins += ` JOIN post_tags pt ON pt.post_id = p.id JOIN tags t ON t.id = pt.tag_id`;
      where.push('t.slug = ?');
      params.push(options.tagSlug);
    }
    if (options.categorySlug) {
      where.push('c.slug = ?');
      params.push(options.categorySlug);
    }
    if (options.authorId) {
      where.push('p.author_id = ?');
      params.push(options.authorId);
    }
    if (options.since && options.since > 0) {
      where.push('p.created_at > ?');
      params.push(options.since);
    }
    if (options.excludeIds?.length) {
      where.push(`p.id NOT IN (${placeholders(options.excludeIds.length)})`);
      params.push(...options.excludeIds);
    }

    if (sort === 'following') {
      if (!viewerId) return [];
      where.push(
        `EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id = ? AND f2.following_id = p.author_id)`,
      );
      params.push(viewerId);
    }

    // Keyset pagination on the active sort key.
    let orderBy: string;
    if (sort === 'trending' || sort === 'foryou') {
      orderBy = 'p.hot_score DESC, p.id DESC';
      if (cursor) {
        where.push('(p.hot_score < ? OR (p.hot_score = ? AND p.id < ?))');
        params.push(cursor.v, cursor.v, cursor.i);
      }
      // "For you" limits the window to recent content so the ranking stays fresh.
      if (sort === 'foryou') {
        where.push('p.created_at > ?');
        params.push(now() - 60 * 60 * 24 * 30);
      }
    } else {
      orderBy = 'p.created_at DESC, p.id DESC';
      if (cursor) {
        where.push('(p.created_at < ? OR (p.created_at = ? AND p.id < ?))');
        params.push(cursor.v, cursor.v, cursor.i);
      }
    }

    return this.db.all<PostWithAuthor>(
      `SELECT ${POST_SELECT} ${joins}
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT ?`,
      [...params, limit + 1],
    );
  }

  /** Posts authored by a user, honouring the viewer's permissions. */
  async byAuthor(options: {
    authorId: string;
    viewerId: string | null;
    cursor: Cursor | null;
    limit: number;
    includeDrafts?: boolean;
    mediaOnly?: boolean;
  }): Promise<PostWithAuthor[]> {
    const where: string[] = ['p.author_id = ?'];
    const params: (string | number)[] = [options.authorId];

    const isSelf = options.viewerId === options.authorId;
    if (isSelf && options.includeDrafts) {
      where.push(`p.status IN ('published', 'draft')`);
    } else if (isSelf) {
      where.push(`p.status = 'published'`);
    } else {
      const visibility = this.visibilityClause(options.viewerId);
      where.push(visibility.sql);
      params.push(...visibility.params);
    }

    if (options.mediaOnly) {
      where.push('EXISTS (SELECT 1 FROM post_media pm WHERE pm.post_id = p.id)');
    }
    if (options.excludeIds?.length) {
      where.push(`p.id NOT IN (${placeholders(options.excludeIds.length)})`);
      params.push(...options.excludeIds);
    }

    if (options.cursor) {
      where.push('(p.created_at < ? OR (p.created_at = ? AND p.id < ?))');
      params.push(options.cursor.v, options.cursor.v, options.cursor.i);
    }

    return this.db.all<PostWithAuthor>(
      `SELECT ${POST_SELECT} ${POST_JOINS}
       WHERE ${where.join(' AND ')}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ?`,
      [...params, options.limit + 1],
    );
  }

  async bookmarkedBy(options: {
    userId: string;
    cursor: Cursor | null;
    limit: number;
  }): Promise<(PostWithAuthor & { bookmarked_at: number })[]> {
    const where: string[] = ['b.user_id = ?', `p.status = 'published'`];
    const params: (string | number)[] = [options.userId];

    if (options.cursor) {
      where.push('(b.created_at < ? OR (b.created_at = ? AND p.id < ?))');
      params.push(options.cursor.v, options.cursor.v, options.cursor.i);
    }

    return this.db.all<PostWithAuthor & { bookmarked_at: number }>(
      `SELECT ${POST_SELECT}, b.created_at AS bookmarked_at
       FROM bookmarks b
       JOIN posts p ON p.id = b.post_id
       JOIN users u ON u.id = p.author_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${where.join(' AND ')}
       ORDER BY b.created_at DESC, p.id DESC
       LIMIT ?`,
      [...params, options.limit + 1],
    );
  }

  async findManyByIds(ids: string[]): Promise<PostWithAuthor[]> {
    if (!ids.length) return [];
    return this.db.all<PostWithAuthor>(
      `SELECT ${POST_SELECT} ${POST_JOINS} WHERE p.id IN (${placeholders(ids.length)})`,
      ids,
    );
  }

  // --- Counters -------------------------------------------------------------

  /**
   * Record a view at most once per viewer per post.
   * Returns true when the counter was actually incremented.
   */
  async recordView(postId: string, viewerKey: string): Promise<boolean> {
    const inserted = await this.db.run(
      'INSERT OR IGNORE INTO post_views (post_id, viewer_key, viewed_at) VALUES (?, ?, ?)',
      [postId, viewerKey, now()],
    );
    if (!inserted.changes) return false;
    await this.db.run('UPDATE posts SET views = views + 1 WHERE id = ?', [postId]);
    return true;
  }

  /** Bump the share counter and return the new value. */
  async incrementShareCount(postId: string): Promise<number> {
    await this.db.run('UPDATE posts SET share_count = share_count + 1 WHERE id = ?', [postId]);
    return (await this.db.scalar<number>('SELECT share_count FROM posts WHERE id = ?', [postId])) ?? 0;
  }

  async recomputeHotScore(postId: string): Promise<void> {
    const row = await this.db.first<{
      reaction_count: number;
      comment_count: number;
      views: number;
      created_at: number;
    }>('SELECT reaction_count, comment_count, views, created_at FROM posts WHERE id = ?', [postId]);
    if (!row) return;
    await this.db.run('UPDATE posts SET hot_score = ? WHERE id = ?', [
      hotScore(row.reaction_count, row.comment_count, row.views, row.created_at),
      postId,
    ]);
  }

  // --- Tags & media ---------------------------------------------------------

  async setTags(postId: string, tagIds: string[]): Promise<void> {
    const ts = now();
    const statements: { sql: string; params: (string | number)[] }[] = [
      { sql: 'DELETE FROM post_tags WHERE post_id = ?', params: [postId] },
    ];
    for (const tagId of tagIds) {
      statements.push({
        sql: 'INSERT OR IGNORE INTO post_tags (post_id, tag_id, created_at) VALUES (?, ?, ?)',
        params: [postId, tagId, ts],
      });
    }
    await this.db.batch(statements);
  }

  async listTags(postId: string): Promise<{ slug: string; name: string }[]> {
    return this.db.all<{ slug: string; name: string }>(
      `SELECT t.slug, t.name FROM post_tags pt
       JOIN tags t ON t.id = pt.tag_id
       WHERE pt.post_id = ? ORDER BY t.slug`,
      [postId],
    );
  }

  async tagsForPosts(postIds: string[]): Promise<Map<string, { slug: string; name: string }[]>> {
    const out = new Map<string, { slug: string; name: string }[]>();
    if (!postIds.length) return out;
    const rows = await this.db.all<{ post_id: string; slug: string; name: string }>(
      `SELECT pt.post_id, t.slug, t.name FROM post_tags pt
       JOIN tags t ON t.id = pt.tag_id
       WHERE pt.post_id IN (${placeholders(postIds.length)})
       ORDER BY t.slug`,
      postIds,
    );
    for (const row of rows) {
      const list = out.get(row.post_id) ?? [];
      list.push({ slug: row.slug, name: row.name });
      out.set(row.post_id, list);
    }
    return out;
  }

  async setMedia(postId: string, media: { mediaId: string; altText?: string }[]): Promise<void> {
    const statements: { sql: string; params: (string | number)[] }[] = [
      { sql: 'DELETE FROM post_media WHERE post_id = ?', params: [postId] },
    ];
    media.forEach((item, index) => {
      statements.push({
        sql: 'INSERT OR IGNORE INTO post_media (post_id, media_id, position, alt_text) VALUES (?, ?, ?, ?)',
        params: [postId, item.mediaId, index, item.altText ?? ''],
      });
    });
    await this.db.batch(statements);
  }

  async mediaForPosts(postIds: string[]) {
    if (!postIds.length) return new Map<string, MediaJoinRow[]>();
    const rows = await this.db.all<MediaJoinRow>(
      `SELECT pm.post_id, pm.position, pm.alt_text, m.id, m.mime_type, m.width, m.height, m.status
       FROM post_media pm
       JOIN media m ON m.id = pm.media_id
       WHERE pm.post_id IN (${placeholders(postIds.length)})
         AND m.status IN ('ready', 'processing')
       ORDER BY pm.position ASC`,
      postIds,
    );
    const out = new Map<string, MediaJoinRow[]>();
    for (const row of rows) {
      const list = out.get(row.post_id) ?? [];
      list.push(row);
      out.set(row.post_id, list);
    }
    return out;
  }

  // --- Admin / stats --------------------------------------------------------

  async listForAdmin(options: { cursor: Cursor | null; limit: number; status?: string }) {
    const where: string[] = ['1 = 1'];
    const params: (string | number)[] = [];

    if (options.status) {
      where.push('p.status = ?');
      params.push(options.status);
    }
    if (options.cursor) {
      where.push('(p.created_at < ? OR (p.created_at = ? AND p.id < ?))');
      params.push(options.cursor.v, options.cursor.v, options.cursor.i);
    }

    return this.db.all<PostWithAuthor>(
      `SELECT ${POST_SELECT} ${POST_JOINS}
       WHERE ${where.join(' AND ')}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ?`,
      [...params, options.limit + 1],
    );
  }

  async countByStatus(status: PostStatus): Promise<number> {
    return (await this.db.scalar<number>('SELECT COUNT(*) FROM posts WHERE status = ?', [status])) ?? 0;
  }
}

export interface MediaJoinRow {
  post_id: string;
  id: string;
  position: number;
  alt_text: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  status: string;
}
