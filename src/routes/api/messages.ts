/**
 * Direct messages. Private by construction: every handler requires a session,
 * every response is `no-store`, and each conversation read re-checks membership
 * in the query rather than trusting the id in the URL.
 *
 * Transport note: sending is HTTP, not WebSocket. One code path then owns
 * validation, rate limiting, CSRF and persistence, and the socket is left as a
 * pure delivery channel that can fail without losing anything.
 */

import { Hono } from 'hono';
import type { AppContext } from '../../types/env';
import { serviceContext } from '../../services/context';
import { MessageService } from '../../services/messages';
import { NotificationService } from '../../services/notifications';
import { readBody } from '../../middleware/body';
import { rateLimit } from '../../middleware/rateLimit';
import { requireAuth, requireUser } from '../../middleware/auth';
import { json } from '../../utils/response';
import { parseOrThrow } from '../../validators/common';
import {
  conversationIdSchema,
  inboxSearchSchema,
  sendAttachmentSchema,
  sendMessageSchema,
  startConversationSchema,
} from '../../validators/messages';
import { MediaService } from '../../services/media';
import { AppError } from '../../utils/errors';
import { decodeCursor, parseLimit } from '../../utils/cursor';

const messages = new Hono<AppContext>();

messages.use('*', requireAuth(), async (c, next) => {
  c.header('cache-control', 'private, no-store');
  await next();
});

/**
 * Inbox: one row per conversation, newest activity first.
 *
 * With `?q=` this becomes the incremental search the conversation list uses on
 * every keystroke: matching conversations first, then a few people the viewer
 * has not messaged yet so a search can turn straight into a new chat.
 */
messages.get('/', async (c) => {
  const viewer = requireUser(c.get('user'));
  const service = new MessageService(serviceContext(c));
  const { q } = parseOrThrow(inboxSearchSchema, { q: c.req.query('q') ?? '' });

  if (q.trim()) {
    const result = await service.searchInbox(viewer.id, q);
    return json(c, { items: result.conversations, people: result.people, query: q });
  }

  const items = await service.listConversations(viewer.id);
  return json(c, { items, people: [] });
});

/** Badge count for the nav, polled alongside notifications. */
messages.get('/unread-count', async (c) => {
  const viewer = requireUser(c.get('user'));
  const count = await new MessageService(serviceContext(c)).unreadConversationCount(viewer.id);
  return json(c, { count });
});

/** Open a conversation with a username, optionally sending the first line. */
messages.post('/', rateLimit('sendMessage'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const body = await readBody(c);
  const input = parseOrThrow(startConversationSchema, body.fields);
  const ctx = serviceContext(c);
  const service = new MessageService(ctx);

  const { conversationId, peerId } = await service.openWith(viewer.id, input.username);

  let message = null;
  if (input.content && input.content.trim()) {
    message = await service.send({ conversationId, senderId: viewer.id, content: input.content });
    notifyPeer(ctx, peerId, viewer, conversationId, message.content);
  }

  return json(c, { conversationId, message }, 201);
});

/**
 * Thread history. `before` pages backwards into the archive; `after` returns
 * only what is new, which is what the polling fallback (and a socket catching
 * up after a reconnect) uses.
 */
messages.get('/:id', async (c) => {
  const viewer = requireUser(c.get('user'));
  const conversationId = parseOrThrow(conversationIdSchema, c.req.param('id'));
  const service = new MessageService(serviceContext(c));
  await service.assertMember(conversationId, viewer.id);

  const after = decodeCursor(c.req.query('after'));
  if (after) {
    const result = await service.since({ conversationId, viewerId: viewer.id, after });
    // Reading the tail of a thread counts as reading it.
    if (result.items.length) await service.markRead(conversationId, viewer.id);
    return json(c, { items: result.items, latestCursor: result.latestCursor, hasMore: false });
  }

  const page = await service.thread({
    conversationId,
    viewerId: viewer.id,
    limit: parseLimit(c.req.query('limit'), 30),
    before: decodeCursor(c.req.query('before')),
  });
  const peer = await service.peerOf(conversationId, viewer.id);
  await service.markRead(conversationId, viewer.id);

  return json(c, {
    ...page,
    conversationId,
    peer: peer
      ? {
          id: peer.user_id,
          username: peer.username,
          displayName: peer.display_name || peer.username,
          avatarMediaId: peer.avatar_media_id,
        }
      : null,
  });
});

/** Send into an existing conversation. */
messages.post('/:id', rateLimit('sendMessage'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const conversationId = parseOrThrow(conversationIdSchema, c.req.param('id'));
  const body = await readBody(c);
  const input = parseOrThrow(sendMessageSchema, body.fields);

  const ctx = serviceContext(c);
  const service = new MessageService(ctx);
  const message = await service.send({
    conversationId,
    senderId: viewer.id,
    content: input.content,
  });

  const peer = await service.peerOf(conversationId, viewer.id);
  if (peer) notifyPeer(ctx, peer.user_id, viewer, conversationId, message.content);

  return json(c, { message, ...(input.clientId ? { clientId: input.clientId } : {}) }, 201);
});

/**
 * Send a photo, a voice clip or a sticker.
 *
 * Photos and voice notes arrive as multipart in the *same* request that creates
 * the bubble: the file goes through the normal media pipeline first (magic-byte
 * sniffing, quota, per-hour cap) and only a stored media id is ever written to
 * the message row. A caller may also pass an existing `mediaId` they own —
 * ownership is re-checked here, so a guessed id cannot be attached to a chat.
 */
messages.post('/:id/attachment', rateLimit('sendMessage'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const conversationId = parseOrThrow(conversationIdSchema, c.req.param('id'));
  const body = await readBody(c);
  const input = parseOrThrow(sendAttachmentSchema, body.fields);

  const ctx = serviceContext(c);
  const service = new MessageService(ctx);
  // Membership before any upload: a stranger must not be able to spend our
  // storage budget on a conversation they cannot read.
  await service.assertMember(conversationId, viewer.id);

  let mediaId: string | null = null;
  if (input.kind !== 'sticker') {
    const file = body.files?.file ?? body.files?.audio ?? body.files?.image;
    if (file) {
      const media = await new MediaService(ctx).upload({
        owner: viewer,
        file,
        declaredType: file.type,
        filename: file.name,
        usage: 'attachment',
        // Chat attachments are as private as the conversation itself.
        visibility: 'private',
      });
      mediaId = media.id;
    } else if (input.mediaId) {
      const existing = await ctx.repos.media.findById(input.mediaId);
      if (!existing || existing.owner_id !== viewer.id) {
        throw AppError.badRequest('That attachment is not available');
      }
      mediaId = existing.id;
    } else {
      throw AppError.badRequest('Attach a file');
    }
  }

  const message = await service.send({
    conversationId,
    senderId: viewer.id,
    content: input.content ?? '',
    kind: input.kind,
    mediaId,
    durationMs: input.durationMs,
  });

  const peer = await service.peerOf(conversationId, viewer.id);
  if (peer) notifyPeer(ctx, peer.user_id, viewer, conversationId, message.content);

  return json(c, { message, ...(input.clientId ? { clientId: input.clientId } : {}) }, 201);
});

/** Explicit read receipt, sent when a thread regains focus. */
messages.post('/:id/read', rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const conversationId = parseOrThrow(conversationIdSchema, c.req.param('id'));
  const service = new MessageService(serviceContext(c));
  await service.assertMember(conversationId, viewer.id);
  await service.markRead(conversationId, viewer.id);
  return json(c, { ok: true });
});

/**
 * A DM notification is a courtesy, not part of delivery: it is deferred and its
 * failure is swallowed by `NotificationService`, so it can never fail a send.
 */
function notifyPeer(
  ctx: ReturnType<typeof serviceContext>,
  peerId: string,
  viewer: { id: string; displayName: string; username: string },
  conversationId: string,
  content: string,
): void {
  ctx.defer(
    new NotificationService(ctx).notify({
      userId: peerId,
      actorId: viewer.id,
      type: 'SYSTEM',
      targetType: 'conversation',
      targetId: conversationId,
      data: {
        kind: 'message',
        title: `${viewer.displayName || viewer.username} sent you a message`,
        preview: content.slice(0, 140),
        conversationId,
      },
    }),
  );
}

export default messages;
