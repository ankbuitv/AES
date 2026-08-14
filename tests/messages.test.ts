/**
 * Direct messages: conversation creation, membership boundaries, thread
 * paging, the `?after=` catch-up used by the polling fallback, read state and
 * the SSR pages.
 *
 * The WebSocket layer is deliberately not exercised here — delivery is a
 * best-effort optimisation on top of these endpoints, and every guarantee that
 * matters (persistence, authorisation, ordering) lives in the HTTP path that
 * these tests drive end to end.
 */

import { describe, expect, it } from 'vitest';
import { TestClient } from './helpers/client';

interface MessageDTO {
  id: string;
  conversationId: string;
  content: string;
  createdAt: number;
  mine: boolean;
  sender: { id: string; username: string; displayName: string };
}

interface ConversationDTO {
  id: string;
  peer: { username: string; displayName: string };
  lastMessage: { content: string; mine: boolean } | null;
  unreadCount: number;
}

interface ThreadPayload {
  items: MessageDTO[];
  nextCursor: string | null;
  hasMore: boolean;
  latestCursor: string | null;
  peer: { username: string } | null;
}

/** Two accounts that share one database, as two browsers on one deployment. */
async function pair(a = 'ana', b = 'ben') {
  const first = new TestClient();
  await first.register({ username: a, displayName: a.toUpperCase() });
  const second = new TestClient();
  Object.assign(second, { env: first.env });
  await second.register({ username: b, displayName: b.toUpperCase() });
  return { first, second };
}

async function openConversation(from: TestClient, to: string, content = 'hello there') {
  const response = await from.post<{ conversationId: string; message: MessageDTO | null }>(
    '/api/messages',
    { username: to, content },
  );
  expect(response.status).toBe(201);
  return response.body.data!;
}

describe('conversations', () => {
  it('creates a conversation, delivers the first message and lists it for both sides', async () => {
    const { first, second } = await pair();
    const { conversationId, message } = await openConversation(first, 'ben', 'first line');

    expect(conversationId).toMatch(/^cnv_/);
    expect(message?.content).toBe('first line');
    expect(message?.mine).toBe(true);

    const inbox = await second.get<{ items: ConversationDTO[] }>('/api/messages');
    expect(inbox.status).toBe(200);
    const row = inbox.body.data!.items.find((item) => item.id === conversationId);
    expect(row).toBeDefined();
    expect(row!.peer.username).toBe('ana');
    expect(row!.lastMessage?.content).toBe('first line');
    // The recipient did not write it, so it is not "mine" from their side.
    expect(row!.lastMessage?.mine).toBe(false);
    expect(row!.unreadCount).toBe(1);
  });

  it('reuses the same conversation instead of creating a second one', async () => {
    const { first } = await pair('cara', 'dan');
    const one = await openConversation(first, 'dan', 'ping');
    const two = await openConversation(first, 'dan', 'ping again');
    expect(two.conversationId).toBe(one.conversationId);

    const inbox = await first.get<{ items: ConversationDTO[] }>('/api/messages');
    expect(inbox.body.data!.items.filter((i) => i.peer.username === 'dan')).toHaveLength(1);
  });

  it('refuses a conversation with yourself and with an unknown user', async () => {
    const client = new TestClient();
    await client.register({ username: 'solo' });

    const self = await client.post('/api/messages', { username: 'solo', content: 'hi' });
    expect(self.status).toBe(400);

    const ghost = await client.post('/api/messages', { username: 'nobodyhere', content: 'hi' });
    expect(ghost.status).toBe(404);
  });

  it('requires a session', async () => {
    const client = new TestClient();
    const response = await client.get('/api/messages');
    expect(response.status).toBe(401);
  });
});

describe('thread access', () => {
  it('hides a conversation from a non-member as 404, not 403', async () => {
    const { first } = await pair('eve', 'finn');
    const { conversationId } = await openConversation(first, 'finn');

    const stranger = new TestClient();
    Object.assign(stranger, { env: first.env });
    await stranger.register({ username: 'snoop' });

    const read = await stranger.get(`/api/messages/${conversationId}`);
    expect(read.status).toBe(404);

    const write = await stranger.post(`/api/messages/${conversationId}`, { content: 'hi' });
    expect(write.status).toBe(404);
  });

  it('rejects an empty or oversized message', async () => {
    const { first } = await pair('gil', 'hana');
    const { conversationId } = await openConversation(first, 'hana');

    const empty = await first.post(`/api/messages/${conversationId}`, { content: '   ' });
    expect(empty.status).toBe(400);

    const huge = await first.post(`/api/messages/${conversationId}`, { content: 'x'.repeat(4_001) });
    expect(huge.status).toBe(400);
  });

  it('never caches a thread', async () => {
    const { first } = await pair('ivy', 'jon');
    const { conversationId } = await openConversation(first, 'jon');
    const response = await first.raw(`/api/messages/${conversationId}`);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
});

describe('thread history', () => {
  it('returns messages oldest-first and pages backwards with a cursor', async () => {
    const { first, second } = await pair('kim', 'lee');
    const { conversationId } = await openConversation(first, 'lee', 'm0');
    for (let i = 1; i < 8; i++) {
      const sender = i % 2 === 0 ? first : second;
      const sent = await sender.post(`/api/messages/${conversationId}`, { content: `m${i}` });
      expect(sent.status).toBe(201);
    }

    const page = await first.get<ThreadPayload>(`/api/messages/${conversationId}?limit=3`);
    expect(page.status).toBe(200);
    const contents = page.body.data!.items.map((m) => m.content);
    // Newest three, presented in reading order.
    expect(contents).toEqual(['m5', 'm6', 'm7']);
    expect(page.body.data!.hasMore).toBe(true);
    expect(page.body.data!.peer?.username).toBe('lee');

    const older = await first.get<ThreadPayload>(
      `/api/messages/${conversationId}?limit=3&before=${encodeURIComponent(page.body.data!.nextCursor!)}`,
    );
    expect(older.body.data!.items.map((m) => m.content)).toEqual(['m2', 'm3', 'm4']);

    const oldest = await first.get<ThreadPayload>(
      `/api/messages/${conversationId}?limit=3&before=${encodeURIComponent(older.body.data!.nextCursor!)}`,
    );
    expect(oldest.body.data!.items.map((m) => m.content)).toEqual(['m0', 'm1']);
    expect(oldest.body.data!.hasMore).toBe(false);
  });

  it('marks messages as mine only for their author', async () => {
    const { first, second } = await pair('mia', 'ned');
    const { conversationId } = await openConversation(first, 'ned', 'from mia');

    const asAuthor = await first.get<ThreadPayload>(`/api/messages/${conversationId}`);
    expect(asAuthor.body.data!.items[0]!.mine).toBe(true);

    const asPeer = await second.get<ThreadPayload>(`/api/messages/${conversationId}`);
    expect(asPeer.body.data!.items[0]!.mine).toBe(false);
    expect(asPeer.body.data!.items[0]!.sender.username).toBe('mia');
  });

  it('returns only new messages for the polling fallback', async () => {
    const { first, second } = await pair('opal', 'pete');
    const { conversationId } = await openConversation(first, 'pete', 'before');

    const initial = await second.get<ThreadPayload>(`/api/messages/${conversationId}`);
    const cursor = initial.body.data!.latestCursor!;
    expect(cursor).toBeTruthy();

    const empty = await second.get<ThreadPayload>(
      `/api/messages/${conversationId}?after=${encodeURIComponent(cursor)}`,
    );
    expect(empty.body.data!.items).toEqual([]);

    await first.post(`/api/messages/${conversationId}`, { content: 'after' });

    const fresh = await second.get<ThreadPayload>(
      `/api/messages/${conversationId}?after=${encodeURIComponent(cursor)}`,
    );
    expect(fresh.body.data!.items.map((m) => m.content)).toEqual(['after']);
    expect(fresh.body.data!.latestCursor).not.toBe(cursor);
  });

  it('echoes the client id so an optimistic bubble can be reconciled', async () => {
    const { first } = await pair('quin', 'rosa');
    const { conversationId } = await openConversation(first, 'rosa');
    const sent = await first.post<{ message: MessageDTO; clientId: string }>(
      `/api/messages/${conversationId}`,
      { content: 'echo me', clientId: 'tmp-123' },
    );
    expect(sent.body.data!.clientId).toBe('tmp-123');
    expect(sent.body.data!.message.id).toMatch(/^msg_/);
    // The author always sees their own send as mine; a broadcast with mine=false
    // is the client's job to re-derive from sender.id.
    expect(sent.body.data!.message.mine).toBe(true);
    expect(sent.body.data!.message.sender.username).toBe('quin');
  });
});

describe('read state', () => {
  it('counts unread conversations and clears them when the thread is read', async () => {
    const { first, second } = await pair('sam', 'tara');
    const { conversationId } = await openConversation(first, 'tara', 'unread one');
    await first.post(`/api/messages/${conversationId}`, { content: 'unread two' });

    const before = await second.get<{ count: number }>('/api/messages/unread-count');
    // Two unread messages, but a single unread conversation: the badge counts
    // threads, like a mail client.
    expect(before.body.data!.count).toBe(1);

    const read = await second.post(`/api/messages/${conversationId}/read`);
    expect(read.status).toBe(200);

    const after = await second.get<{ count: number }>('/api/messages/unread-count');
    expect(after.body.data!.count).toBe(0);

    const sender = await first.get<{ count: number }>('/api/messages/unread-count');
    // Your own messages are never unread for you.
    expect(sender.body.data!.count).toBe(0);
  });

  it('does not let a non-member mark a conversation read', async () => {
    const { first } = await pair('uma', 'vic');
    const { conversationId } = await openConversation(first, 'vic');

    const stranger = new TestClient();
    Object.assign(stranger, { env: first.env });
    await stranger.register({ username: 'lurker' });

    const response = await stranger.post(`/api/messages/${conversationId}/read`);
    expect(response.status).toBe(404);
  });

  it('notifies the recipient of a new message', async () => {
    const { first, second } = await pair('wren', 'xena');
    await openConversation(first, 'xena', 'notify me');

    const notifications = await second.get<{ items: { type: string }[] }>('/api/notifications');
    expect(notifications.status).toBe(200);
    expect(notifications.body.data!.items.length).toBeGreaterThan(0);
  });
});

describe('messages pages', () => {
  it('renders the inbox with each conversation', async () => {
    const { first } = await pair('yuri', 'zed');
    await openConversation(first, 'zed', 'server rendered');

    const response = await first.raw('/messages', { headers: { accept: 'text/html' } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-conversation-list');
    expect(html).toContain('ZED');
    expect(html).toContain('server rendered');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('renders a thread with its history and a working composer', async () => {
    const { first, second } = await pair('amy', 'bobby');
    const { conversationId } = await openConversation(first, 'bobby', 'hello bobby');
    await second.post(`/api/messages/${conversationId}`, { content: 'hello amy' });

    const response = await first.raw(`/messages/${conversationId}`, {
      headers: { accept: 'text/html' },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`data-conversation="${conversationId}"`);
    expect(html).toContain('hello bobby');
    expect(html).toContain('hello amy');
    expect(html).toContain('data-message-form');
    // The no-JS path posts straight to the API.
    expect(html).toContain(`action="/api/messages/${conversationId}"`);
  });

  it('escapes message content in the rendered thread', async () => {
    const { first } = await pair('cleo', 'dex');
    const { conversationId } = await openConversation(first, 'dex', '<script>alert(1)</script>');

    const response = await first.raw(`/messages/${conversationId}`, {
      headers: { accept: 'text/html' },
    });
    const html = await response.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('404s a thread the viewer is not part of', async () => {
    const { first } = await pair('eli', 'fay');
    const { conversationId } = await openConversation(first, 'fay');

    const stranger = new TestClient();
    Object.assign(stranger, { env: first.env });
    await stranger.register({ username: 'peeper' });

    const response = await stranger.raw(`/messages/${conversationId}`, {
      headers: { accept: 'text/html' },
    });
    expect(response.status).toBe(404);
  });

  it('refuses anonymous visitors', async () => {
    const client = new TestClient();
    const response = await client.raw('/messages', { headers: { accept: 'text/html' } });
    expect(response.status).toBe(401);
  });
});
