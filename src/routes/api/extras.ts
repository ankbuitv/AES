import { Hono } from 'hono';
import type { AppContext } from '../../types/env';
import { serviceContext } from '../../services/context';
import { PostService } from '../../services/posts';
import { requireAuth, requireUser } from '../../middleware/auth';
import { rateLimit, readLimit } from '../../middleware/rateLimit';
import { json } from '../../utils/response';
import { parseOrThrow, idSchema } from '../../validators/common';
import { AppError } from '../../utils/errors';
import { z } from 'zod';

const extras = new Hono<AppContext>();

extras.get('/reactions/:id', readLimit(), async (c) => {
  const people = await serviceContext(c).repos.extras.listReactors('post', c.req.param('id'));
  return json(c, {
    people: people.map((p) => ({
      username: p.username,
      displayName: p.display_name,
      avatarMediaId: p.avatar_media_id,
      reaction: p.reaction_type,
    })),
  });
});

extras.get('/revisions/:id', requireAuth(), readLimit(), async (c) => {
  const viewer = requireUser(c.get('user'));
  const post = await new PostService(serviceContext(c)).getById(c.req.param('id'), viewer);
  if (!post.canEdit) throw AppError.forbidden('Only the author can read history');
  const items = await serviceContext(c).repos.extras.listRevisions(post.id);
  return json(c, { items });
});

extras.get('/related/:id', readLimit(), async (c) => {
  const ids = await serviceContext(c).repos.extras.relatedPostIds(c.req.param('id'), 5);
  const posts = await serviceContext(c).repos.posts.findManyByIds(ids);
  return json(c, {
    posts: posts.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title || p.excerpt.slice(0, 80),
      author: p.author_username,
    })),
  });
});

extras.post('/posts/:id/vote', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const body = await c.req.parseBody();
  const optionId = parseOrThrow(idSchema, String(body.optionId ?? ''));
  await serviceContext(c).repos.extras.votePoll({
    userId: viewer.id,
    postId: c.req.param('id'),
    optionId,
  });
  const polls = await serviceContext(c).repos.extras.pollForPosts([c.req.param('id')]);
  return json(c, { options: polls.get(c.req.param('id')) ?? [] });
});

extras.post('/repost/:id', requireAuth(), rateLimit('createPost'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const source = await new PostService(serviceContext(c)).getById(c.req.param('id'), viewer);
  const post = await new PostService(serviceContext(c)).create({
    author: viewer,
    title: '',
    content: `Repost of [@${source.author.username}](/u/${source.author.username}): ${source.excerpt || source.title || 'post'}`,
    contentType: 'markdown',
    visibility: 'public',
    status: 'published',
    quotePostId: source.id,
  });
  return json(c, { post }, 201);
});

extras.post('/tags/:slug/follow', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const tag = await serviceContext(c).repos.tags.findBySlug(c.req.param('slug'));
  if (!tag) throw AppError.notFound('Unknown tag');
  const following = await serviceContext(c).repos.extras.followTag(viewer.id, tag.id);
  return json(c, { following });
});

extras.post('/mutes', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const body = await c.req.parseBody();
  const kind = body.kind === 'user' ? 'user' : 'word';
  const targetId = String(body.targetId ?? '');
  const word = String(body.word ?? '');
  await serviceContext(c).repos.extras.addMute(viewer.id, kind, targetId, word);
  return json(c, { ok: true });
});

extras.delete('/mutes', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const kind = c.req.query('kind') === 'user' ? 'user' : 'word';
  await serviceContext(c).repos.extras.removeMute(
    viewer.id,
    kind,
    c.req.query('targetId') ?? '',
    c.req.query('word') ?? '',
  );
  return json(c, { ok: true });
});

extras.get('/mutes', requireAuth(), async (c) => {
  const viewer = requireUser(c.get('user'));
  return json(c, { items: await serviceContext(c).repos.extras.listMutes(viewer.id) });
});

extras.get('/collections', requireAuth(), async (c) => {
  const viewer = requireUser(c.get('user'));
  return json(c, { items: await serviceContext(c).repos.extras.listCollections(viewer.id) });
});

extras.post('/collections', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const body = await c.req.parseBody();
  const name = String(body.name ?? '').trim();
  if (!name) throw AppError.badRequest('Name required');
  const id = await serviceContext(c).repos.extras.createCollection(viewer.id, name);
  return json(c, { id, name }, 201);
});

extras.post('/collections/assign', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const body = await c.req.parseBody();
  await serviceContext(c).repos.extras.assignBookmarkCollection(
    viewer.id,
    String(body.postId ?? ''),
    String(body.collectionId ?? '') || null,
  );
  return json(c, { ok: true });
});

extras.get('/messages', requireAuth(), async (c) => {
  const viewer = requireUser(c.get('user'));
  return json(c, { items: await serviceContext(c).repos.extras.listConversations(viewer.id) });
});

extras.post('/messages', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const body = await c.req.parseBody();
  const username = String(body.username ?? '').toLowerCase();
  const content = String(body.content ?? '').trim();
  if (!content) throw AppError.badRequest('Write a message');
  const peer = await serviceContext(c).repos.users.findByUsername(username);
  if (!peer) throw AppError.notFound('User not found');
  if (peer.id === viewer.id) throw AppError.badRequest('Cannot message yourself');
  const conversationId = await serviceContext(c).repos.extras.findOrCreateConversation(
    viewer.id,
    peer.id,
  );
  await serviceContext(c).repos.extras.sendMessage(conversationId, viewer.id, content.slice(0, 4000));
  return json(c, { conversationId }, 201);
});

extras.get('/messages/:id', requireAuth(), async (c) => {
  const viewer = requireUser(c.get('user'));
  if (!(await serviceContext(c).repos.extras.isMember(c.req.param('id'), viewer.id))) {
    throw AppError.forbidden('Not in this conversation');
  }
  return json(c, { items: await serviceContext(c).repos.extras.listMessages(c.req.param('id')) });
});

extras.post('/prefs/digest', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const body = await c.req.parseBody();
  await serviceContext(c).repos.extras.setDigest(viewer.id, body.enabled !== '0');
  return json(c, { ok: true });
});

extras.post('/push', requireAuth(), rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const body = await c.req.parseBody();
  await serviceContext(c).repos.extras.savePush(
    viewer.id,
    String(body.endpoint ?? ''),
    String(body.keys ?? '{}'),
  );
  return json(c, { ok: true });
});

export default extras;
