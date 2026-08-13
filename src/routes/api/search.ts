/**
 * Search, tags and categories — the discovery surface.
 *
 * Search runs behind the `SearchProvider` abstraction, so the FTS5 index can be
 * replaced by an external engine without touching this file.
 */

import { Hono } from 'hono';
import type { AppContext } from '../../types/env';
import { serviceContext } from '../../services/context';
import { getSearchProvider, parseSearchOffset } from '../../services/search';
import { PostService } from '../../services/posts';
import { rateLimit, readLimit } from '../../middleware/rateLimit';
import { json } from '../../utils/response';
import { parseOrThrow } from '../../validators/common';
import { searchQuerySchema } from '../../validators/users';
import { parseLimit } from '../../utils/cursor';

const search = new Hono<AppContext>();

search.get('/', rateLimit('search'), async (c) => {
  const input = parseOrThrow(searchQuerySchema, c.req.query());
  const ctx = serviceContext(c);
  const viewer = c.get('user');

  const provider = getSearchProvider(ctx.repos.db, ctx.repos);
  const results = await provider.search({
    query: input.q,
    type: input.type,
    viewerId: viewer?.id ?? null,
    limit: parseLimit(input.limit === undefined ? undefined : String(input.limit)),
    offset: parseSearchOffset(input.cursor),
  });

  // Post hits are raw rows; hydrate them into DTOs so the client renders the
  // same shape it gets from a feed.
  const postService = new PostService(ctx);
  const posts = await Promise.all(
    results.posts.map((hit) => postService.toDTO(hit.post, { viewer })),
  );

  // Search results are viewer-dependent (visibility filtering), so no shared
  // caching.
  c.header('cache-control', 'private, no-store');

  return json(c, {
    query: results.query,
    type: input.type,
    posts,
    users: results.users,
    tags: results.tags.map((t) => ({ slug: t.slug, name: t.name, postCount: t.post_count })),
    nextCursor: results.nextCursor,
    hasMore: results.hasMore,
  });
});

export default search;

// ---------------------------------------------------------------------------
// Tags & categories
// ---------------------------------------------------------------------------

export const tags = new Hono<AppContext>();

tags.get('/', readLimit(), async (c) => {
  const rows = await serviceContext(c).repos.tags.trending(20);
  c.header('cache-control', 'public, max-age=0, s-maxage=300');
  return json(c, {
    tags: rows.map((t) => ({ slug: t.slug, name: t.name, postCount: t.post_count })),
  });
});

tags.get('/:slug/posts', readLimit(), async (c) => {
  const slug = (c.req.param('slug') || '').toLowerCase();
  const page = await new PostService(serviceContext(c)).feed({
    sort: 'latest',
    viewer: c.get('user'),
    cursor: null,
    limit: parseLimit(c.req.query('limit')),
    tagSlug: slug,
  });
  c.header('cache-control', c.get('user') ? 'private, no-store' : 'public, s-maxage=60');
  return json(c, page);
});

export const categories = new Hono<AppContext>();

categories.get('/', readLimit(), async (c) => {
  const rows = await serviceContext(c).repos.categories.list();
  c.header('cache-control', 'public, max-age=0, s-maxage=600');
  return json(c, {
    categories: rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      description: row.description,
      postCount: row.post_count,
    })),
  });
});
