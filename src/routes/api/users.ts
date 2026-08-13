/**
 * Profiles, follows, blocks and the viewer's own settings.
 *
 * Profile reads are public but still pass through the service so suspended,
 * banned and deleted accounts stay invisible to everyone but staff.
 */

import { Hono } from 'hono';
import type { AppContext } from '../../types/env';
import { serviceContext } from '../../services/context';
import { UserService } from '../../services/users';
import { PostService } from '../../services/posts';
import { MediaService } from '../../services/media';
import { readBody } from '../../middleware/body';
import { rateLimit, readLimit } from '../../middleware/rateLimit';
import { requireAuth, requireUser } from '../../middleware/auth';
import { json, noContent } from '../../utils/response';
import { parseOrThrow, usernameParamSchema } from '../../validators/common';
import { updateProfileSchema } from '../../validators/users';
import { decodeCursor, parseLimit } from '../../utils/cursor';

const users = new Hono<AppContext>();

/** Public listings may be edge-cached briefly; personalised views may not. */
function readCache(c: Parameters<typeof json>[0]): void {
  if (c.get('user')) c.header('cache-control', 'private, no-store');
  else c.header('cache-control', 'public, max-age=0, s-maxage=60, must-revalidate');
}

users.get('/suggested', readLimit(), async (c) => {
  const viewer = c.get('user');
  const list = await new UserService(serviceContext(c)).suggested(viewer?.id ?? null, 5);
  c.header('cache-control', 'private, no-store');
  return json(c, { users: list });
});

users.get('/leaderboard', readLimit(), async (c) => {
  const board = await new UserService(serviceContext(c)).leaderboard(20);
  c.header('cache-control', 'public, max-age=0, s-maxage=300');
  return json(c, { leaderboard: board });
});

users.get('/:username', readLimit(), async (c) => {
  const username = parseOrThrow(usernameParamSchema, c.req.param('username'));
  const profile = await new UserService(serviceContext(c)).profile(username, c.get('user'));
  readCache(c);
  return json(c, { user: profile });
});

users.get('/:username/posts', readLimit(), async (c) => {
  const username = parseOrThrow(usernameParamSchema, c.req.param('username'));
  const ctx = serviceContext(c);
  const profile = await new UserService(ctx).profile(username, c.get('user'));

  const page = await new PostService(ctx).byAuthor({
    authorId: profile.id,
    viewer: c.get('user'),
    cursor: decodeCursor(c.req.query('cursor')),
    limit: parseLimit(c.req.query('limit')),
    ...(c.req.query('media') === '1' ? { mediaOnly: true } : {}),
  });

  readCache(c);
  return json(c, page);
});

users.get('/:username/replies', readLimit(), async (c) => {
  const username = parseOrThrow(usernameParamSchema, c.req.param('username'));
  const ctx = serviceContext(c);
  const profile = await new UserService(ctx).profile(username, c.get('user'));

  const page = await new PostService(ctx).commentsByAuthor({
    authorId: profile.id,
    viewer: c.get('user'),
    cursor: decodeCursor(c.req.query('cursor')),
    limit: parseLimit(c.req.query('limit')),
  });

  readCache(c);
  return json(c, page);
});

users.get('/:username/followers', readLimit(), async (c) => {
  const username = parseOrThrow(usernameParamSchema, c.req.param('username'));
  const page = await new UserService(serviceContext(c)).followers(
    username,
    decodeCursor(c.req.query('cursor')),
    parseLimit(c.req.query('limit')),
  );
  readCache(c);
  return json(c, page);
});

users.get('/:username/following', readLimit(), async (c) => {
  const username = parseOrThrow(usernameParamSchema, c.req.param('username'));
  const page = await new UserService(serviceContext(c)).following(
    username,
    decodeCursor(c.req.query('cursor')),
    parseLimit(c.req.query('limit')),
  );
  readCache(c);
  return json(c, page);
});

// --- Relationships ---------------------------------------------------------

users.post('/:username/follow', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const username = parseOrThrow(usernameParamSchema, c.req.param('username'));
  const result = await new UserService(serviceContext(c)).follow(viewer, username);
  return json(c, result);
});

users.delete('/:username/follow', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const username = parseOrThrow(usernameParamSchema, c.req.param('username'));
  const result = await new UserService(serviceContext(c)).unfollow(viewer, username);
  return json(c, result);
});

/**
 * HTML forms can only issue GET/POST, so the no-JavaScript fallback posts to
 * these aliases. They are the same handlers as the DELETE variants above.
 */
users.post('/:username/unfollow', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const username = parseOrThrow(usernameParamSchema, c.req.param('username'));
  const result = await new UserService(serviceContext(c)).unfollow(viewer, username);
  return json(c, result);
});

users.post('/:username/block', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const username = parseOrThrow(usernameParamSchema, c.req.param('username'));
  await new UserService(serviceContext(c)).block(viewer, username);
  return json(c, { blocked: true });
});

users.delete('/:username/block', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const username = parseOrThrow(usernameParamSchema, c.req.param('username'));
  await new UserService(serviceContext(c)).unblock(viewer, username);
  return json(c, { blocked: false });
});

users.post('/:username/unblock', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const username = parseOrThrow(usernameParamSchema, c.req.param('username'));
  await new UserService(serviceContext(c)).unblock(viewer, username);
  return json(c, { blocked: false });
});

export default users;

// ---------------------------------------------------------------------------
// `/api/me` — the viewer's own record. Separate router, mounted alongside.
// ---------------------------------------------------------------------------

export const me = new Hono<AppContext>();

me.use('*', requireAuth());

me.patch('/profile', rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const body = await readBody(c);
  const input = parseOrThrow(updateProfileSchema, body.fields);

  const ctx = serviceContext(c);
  const service = new UserService(ctx);

  // Avatar/cover are media ids, and ownership is verified by MediaService —
  // a client cannot point their avatar at somebody else's upload.
  if (input.avatarMediaId !== undefined) {
    await new MediaService(ctx).setProfileImage({
      viewer,
      mediaId: input.avatarMediaId,
      kind: 'avatar',
    });
  }
  if (input.coverMediaId !== undefined) {
    await new MediaService(ctx).setProfileImage({
      viewer,
      mediaId: input.coverMediaId,
      kind: 'cover',
    });
  }

  const updated = await service.updateProfile(viewer, {
    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    ...(input.bio !== undefined ? { bio: input.bio } : {}),
    ...(input.location !== undefined ? { location: input.location } : {}),
    ...(input.website !== undefined ? { website: input.website } : {}),
  });

  return json(c, { user: updated });
});

me.get('/bookmarks', async (c) => {
  const viewer = requireUser(c.get('user'));
  const page = await new PostService(serviceContext(c)).bookmarks({
    viewer,
    cursor: decodeCursor(c.req.query('cursor')),
    limit: parseLimit(c.req.query('limit')),
  });
  c.header('cache-control', 'private, no-store');
  return json(c, page);
});

me.get('/media', async (c) => {
  const viewer = requireUser(c.get('user'));
  const page = await new MediaService(serviceContext(c)).listForOwner({
    ownerId: viewer.id,
    cursor: decodeCursor(c.req.query('cursor')),
    limit: parseLimit(c.req.query('limit')),
  });
  c.header('cache-control', 'private, no-store');
  return json(c, page);
});

me.delete('/avatar', rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  await new MediaService(serviceContext(c)).setProfileImage({
    viewer,
    mediaId: null,
    kind: 'avatar',
  });
  return noContent();
});
