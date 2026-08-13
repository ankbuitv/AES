/**
 * Posts, feeds, reactions, bookmarks and comments.
 *
 * Reads are cursor-paginated and never use OFFSET; writes go through the
 * post service, which owns visibility, XP and notification side effects.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../../types/env';
import { serviceContext } from '../../services/context';
import { PostService } from '../../services/posts';
import type { FeedSort } from '../../db/repositories/posts';
import { readBody } from '../../middleware/body';
import { rateLimit, readLimit } from '../../middleware/rateLimit';
import { requireAuth, requireUser } from '../../middleware/auth';
import { json, noContent } from '../../utils/response';
import { parseOrThrow } from '../../validators/common';
import {
  createCommentSchema,
  createPostSchema,
  feedQuerySchema,
  updateCommentSchema,
  updatePostSchema,
} from '../../validators/posts';
import { reactionTargetSchema, reactionTypeSchema, idSchema } from '../../validators/common';
import { decodeCursor, parseLimit } from '../../utils/cursor';
import { AppError } from '../../utils/errors';
import { z } from 'zod';

const posts = new Hono<AppContext>();

function service(c: Context<AppContext>): PostService {
  return new PostService(serviceContext(c));
}

/** Feed reads for signed-in members are personalised, so never shared-cached. */
function feedCacheHeaders(c: Context<AppContext>, sort: FeedSort): void {
  if (c.get('user') || sort === 'following' || sort === 'foryou') {
    c.header('cache-control', 'private, no-store');
  } else {
    c.header('cache-control', 'public, max-age=0, s-maxage=30, must-revalidate');
    c.header('vary', 'Cookie');
  }
}

// --- Feeds -----------------------------------------------------------------

posts.get('/', readLimit(), async (c) => {
  const query = parseOrThrow(feedQuerySchema, c.req.query());
  const sort = query.sort as FeedSort;

  if (sort === 'following' && !c.get('user')) {
    throw AppError.unauthenticated('Sign in to see posts from people you follow');
  }

  const page = await service(c).feed({
    sort,
    viewer: c.get('user'),
    cursor: decodeCursor(query.cursor),
    limit: parseLimit(query.limit === undefined ? undefined : String(query.limit)),
    ...(query.tag ? { tagSlug: query.tag.toLowerCase() } : {}),
    ...(query.category ? { categorySlug: query.category.toLowerCase() } : {}),
    ...(query.since !== undefined
      ? { since: Math.max(0, Math.floor(Number(query.since)) || 0) }
      : {}),
    ...(query.window ? { window: query.window } : {}),
    ...(query.tags === 'followed' ? { followedTagsOnly: true } : {}),
  });

  feedCacheHeaders(c, sort);
  return json(c, page);
});

posts.get('/bookmarks', requireAuth(), readLimit(), async (c) => {
  const viewer = requireUser(c.get('user'));
  const page = await service(c).bookmarks({
    viewer,
    cursor: decodeCursor(c.req.query('cursor')),
    limit: parseLimit(c.req.query('limit')),
  });
  c.header('cache-control', 'private, no-store');
  return json(c, page);
});

// --- Single post -----------------------------------------------------------

posts.get('/:idOrSlug', readLimit(), async (c) => {
  const key = c.req.param('idOrSlug');
  const svc = service(c);
  const viewer = c.get('user');

  const post = key.startsWith('pst_')
    ? await svc.getById(key, viewer)
    : await svc.viewBySlug(key, viewer);

  c.header('cache-control', viewer ? 'private, no-store' : 'public, max-age=0, s-maxage=60');
  return json(c, { post });
});

posts.post('/', requireAuth(), rateLimit('createPost'), async (c) => {
  const author = requireUser(c.get('user'));
  const body = await readBody(c);
  const input = parseOrThrow(createPostSchema, body.fields);

  const post = await service(c).create({
    author,
    title: input.title,
    content: input.content,
    contentType: input.contentType,
    visibility: input.visibility,
    status: input.status,
    ...(input.category ? { categorySlug: input.category } : {}),
    ...(input.linkUrl ? { linkUrl: input.linkUrl } : {}),
    ...(input.codeLanguage ? { codeLanguage: input.codeLanguage } : {}),
    ...(input.tags ? { tags: input.tags } : {}),
    ...(input.mediaIds ? { mediaIds: input.mediaIds } : {}),
  });

  return json(c, { post }, 201);
});

posts.patch('/:id', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const body = await readBody(c);
  const input = parseOrThrow(updatePostSchema, body.fields);

  const post = await service(c).update({
    postId: c.req.param('id'),
    viewer,
    patch: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.category !== undefined ? { categorySlug: input.category } : {}),
      ...(input.linkUrl !== undefined ? { linkUrl: input.linkUrl } : {}),
      ...(input.codeLanguage !== undefined ? { codeLanguage: input.codeLanguage } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.mediaIds !== undefined ? { mediaIds: input.mediaIds } : {}),
    },
  });

  return json(c, { post });
});

posts.delete('/:id', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  await service(c).remove({ postId: c.req.param('id'), viewer });
  return noContent();
});

// --- Engagement ------------------------------------------------------------

const reactSchema = z.object({
  reaction: reactionTypeSchema,
  targetType: reactionTargetSchema.optional().default('post'),
});

posts.post('/:id/reactions', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const body = await readBody(c);
  const input = parseOrThrow(reactSchema, body.fields);

  const result = await service(c).react({
    viewer,
    targetType: input.targetType,
    targetId: parseOrThrow(idSchema, c.req.param('id')),
    reaction: input.reaction,
  });
  return json(c, result);
});

posts.post('/:id/pin', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const result = await service(c).pin({
    viewer,
    postId: parseOrThrow(idSchema, c.req.param('id')),
  });
  return json(c, result);
});

posts.post('/:id/bookmark', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const result = await service(c).bookmark({
    viewer,
    postId: parseOrThrow(idSchema, c.req.param('id')),
  });
  return json(c, result);
});

/**
 * Share is a client-side action (copy link / native share sheet); this endpoint
 * exists so the count is server-owned and cannot be inflated per render.
 */
posts.post('/:id/share', rateLimit('write'), async (c) => {
  const svc = service(c);
  const post = await svc.getById(parseOrThrow(idSchema, c.req.param('id')), c.get('user'));
  const count = await serviceContext(c).repos.posts.incrementShareCount(post.id);
  return json(c, { shareCount: count });
});

// --- Comments --------------------------------------------------------------

const threadQuerySchema = z.object({
  cursor: z.string().max(256).optional(),
  limit: z.union([z.string(), z.number()]).optional(),
  order: z.enum(['newest', 'oldest', 'top']).optional().default('newest'),
});

posts.get('/:id/comments', readLimit(), async (c) => {
  const query = parseOrThrow(threadQuerySchema, c.req.query());
  const svc = service(c);
  // Resolve through the service so the post's visibility rules apply to its
  // comments as well.
  const post = await svc.getById(parseOrThrow(idSchema, c.req.param('id')), c.get('user'));

  const page = await svc.commentThread({
    postId: post.id,
    viewer: c.get('user'),
    cursor: decodeCursor(query.cursor),
    limit: parseLimit(query.limit === undefined ? undefined : String(query.limit)),
    order: query.order,
  });

  c.header('cache-control', c.get('user') ? 'private, no-store' : 'public, max-age=0, s-maxage=30');
  return json(c, page);
});

posts.post('/:id/comments', requireAuth(), rateLimit('createComment'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const body = await readBody(c);
  const input = parseOrThrow(createCommentSchema, body.fields);

  const comment = await service(c).comment({
    viewer,
    postId: parseOrThrow(idSchema, c.req.param('id')),
    parentId: input.parentId ?? null,
    content: input.content,
  });

  return json(c, { comment }, 201);
});

export default posts;
