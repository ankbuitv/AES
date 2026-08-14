/**
 * Reels API — short vertical video.
 *
 * Reading is public (reels are a public surface, like the feed) and briefly
 * shared-cacheable for anonymous visitors. Writing requires a session, passes
 * through CSRF at the router level and is rate limited like any other post.
 *
 * Nothing here ever fetches a third-party page: importing a reel parses the
 * pasted URL locally and stores an id, so an import cannot be turned into a
 * server-side request forgery primitive.
 */

import { Hono } from 'hono';
import type { AppContext } from '../../types/env';
import { serviceContext } from '../../services/context';
import { ReelService } from '../../services/reels';
import { readBody } from '../../middleware/body';
import { rateLimit, readLimit } from '../../middleware/rateLimit';
import { requireAuth, requireUser } from '../../middleware/auth';
import { json, noContent } from '../../utils/response';
import { idSchema, parseOrThrow } from '../../validators/common';
import { importReelSchema, reelSortSchema, uploadReelSchema } from '../../validators/reels';
import { decodeCursor, parseLimit } from '../../utils/cursor';
import type { ReelProvider } from '../../services/reelSources';

const reels = new Hono<AppContext>();

const PROVIDERS = new Set(['upload', 'youtube', 'tiktok', 'instagram', 'facebook']);

/** The reel feed. `sort=popular` ranks by likes, otherwise newest first. */
reels.get('/', readLimit(), async (c) => {
  const viewer = c.get('user');
  const providerParam = c.req.query('provider');
  const provider = providerParam && PROVIDERS.has(providerParam) ? (providerParam as ReelProvider) : null;

  const page = await new ReelService(serviceContext(c)).feed({
    sort: parseOrThrow(reelSortSchema, c.req.query('sort')),
    viewerId: viewer?.id ?? null,
    provider,
    cursor: decodeCursor(c.req.query('cursor')),
    limit: parseLimit(c.req.query('limit'), 10),
  });

  // The viewer's own like state is embedded in each item, so a signed-in
  // response must never be shared.
  if (viewer) c.header('cache-control', 'private, no-store');
  else c.header('cache-control', 'public, max-age=0, s-maxage=30, must-revalidate');

  return json(c, page);
});

reels.get('/:id', readLimit(), async (c) => {
  const viewer = c.get('user');
  const id = parseOrThrow(idSchema, c.req.param('id'));
  const service = new ReelService(serviceContext(c));
  const reel = await service.get(id, viewer?.id ?? null);
  service.countView(id);
  c.header('cache-control', 'private, no-store');
  return json(c, { reel });
});

/** Import a YouTube Shorts / TikTok / Instagram / Facebook video by link. */
reels.post('/import', requireAuth(), rateLimit('createPost'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const body = await readBody(c);
  const input = parseOrThrow(importReelSchema, body.fields);

  const reel = await new ReelService(serviceContext(c)).importFromUrl({
    authorId: viewer.id,
    url: input.url,
    ...(input.title ? { title: input.title } : {}),
    ...(input.caption ? { caption: input.caption } : {}),
  });

  return json(c, { reel }, 201);
});

/** Publish a reel from a video the member already uploaded to their library. */
reels.post('/', requireAuth(), rateLimit('createPost'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const body = await readBody(c);
  const input = parseOrThrow(uploadReelSchema, body.fields);

  const reel = await new ReelService(serviceContext(c)).createFromUpload({
    authorId: viewer.id,
    mediaId: input.mediaId,
    ...(input.title ? { title: input.title } : {}),
    ...(input.caption ? { caption: input.caption } : {}),
  });

  return json(c, { reel }, 201);
});

reels.post('/:id/like', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const id = parseOrThrow(idSchema, c.req.param('id'));
  const result = await new ReelService(serviceContext(c)).toggleLike(id, viewer.id);
  c.header('cache-control', 'private, no-store');
  return json(c, result);
});

reels.delete('/:id', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const id = parseOrThrow(idSchema, c.req.param('id'));
  await new ReelService(serviceContext(c)).remove(id, { id: viewer.id, role: viewer.role });
  return noContent();
});

export default reels;
