/**
 * Rich direct messages: emoji, photos, voice notes, stickers, and the
 * incremental inbox search.
 *
 * The interesting assertions are the boundaries rather than the happy paths:
 * an attachment sent into a private conversation must be readable by the
 * recipient and by nobody else, and a search term must not be able to widen
 * its own LIKE pattern.
 */

import { describe, expect, it } from 'vitest';
import { TestClient } from './helpers/client';
import { TINY_PNG } from './helpers/env';
import { MessageService } from '../src/services/messages';

interface MessageDTO {
  id: string;
  conversationId: string;
  content: string;
  kind: string;
  mediaUrl: string | null;
  durationMs: number;
  mine: boolean;
}

interface ThreadPayload {
  items: MessageDTO[];
}

interface InboxPayload {
  items: { id: string; peer: { username: string } }[];
  people: { username: string }[];
}

/** A minimal but genuine Matroska header — what MediaRecorder's WebM starts with. */
const WEBM_AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Array(256).fill(0)]);

async function pair(a = 'ana', b = 'ben') {
  const first = new TestClient();
  await first.register({ username: a, displayName: a.toUpperCase() });
  const second = new TestClient();
  Object.assign(second, { env: first.env });
  await second.register({ username: b, displayName: b.toUpperCase() });

  const opened = await first.post<{ conversationId: string }>('/api/messages', {
    username: b,
    content: 'hello',
  });
  return { first, second, conversationId: opened.body.data!.conversationId };
}

/** Post a multipart attachment the way the browser composer does. */
async function sendAttachment(
  client: TestClient,
  conversationId: string,
  fields: Record<string, string>,
  file?: { name: string; type: string; bytes: Uint8Array },
) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  if (file) {
    form.set('file', new File([file.bytes as unknown as ArrayBufferView], file.name, { type: file.type }));
  }
  return client.request<{ message: MessageDTO }>(`/api/messages/${conversationId}/attachment`, {
    method: 'POST',
    body: form,
  });
}

describe('emoji in messages', () => {
  it('round-trips emoji, skin tones and ZWJ sequences untouched', async () => {
    const { first, conversationId } = await pair();
    const text = 'Chào bro 👋🏽 🎉🔥 👨‍👩‍👧‍👦 ❤️';

    const sent = await first.post<{ message: MessageDTO }>(`/api/messages/${conversationId}`, {
      content: text,
    });
    expect(sent.status).toBe(201);
    expect(sent.body.data!.message.content).toBe(text);
    expect(sent.body.data!.message.kind).toBe('text');
  });

  it('still rejects genuine control characters', () => {
    expect(() => MessageService.sanitize('hello\u0007world')).toThrow();
    // …while leaving newlines, which are meaningful in chat, alone.
    expect(MessageService.sanitize('one\ntwo')).toBe('one\ntwo');
  });
});

describe('photo messages', () => {
  it('uploads and attaches a photo in one request', async () => {
    const { first, conversationId } = await pair();

    const response = await sendAttachment(
      first,
      conversationId,
      { kind: 'image', content: 'Look at this' },
      { name: 'pixel.png', type: 'image/png', bytes: TINY_PNG },
    );

    expect(response.status).toBe(201);
    const message = response.body.data!.message;
    expect(message.kind).toBe('image');
    expect(message.content).toBe('Look at this');
    expect(message.mediaUrl).toMatch(/^\/media\//);
  });

  it('falls back to a readable label when no caption is written', async () => {
    const { first, conversationId } = await pair();
    const response = await sendAttachment(
      first,
      conversationId,
      { kind: 'image' },
      { name: 'pixel.png', type: 'image/png', bytes: TINY_PNG },
    );
    // Inbox previews and screen readers must never get an empty string.
    expect(response.body.data!.message.content).toBe('Photo');
  });

  it('refuses an attachment with no file and no media id', async () => {
    const { first, conversationId } = await pair();
    const response = await sendAttachment(first, conversationId, { kind: 'image' });
    expect(response.status).toBe(400);
  });
});

describe('voice messages', () => {
  it('stores a clip with its duration', async () => {
    const { first, conversationId } = await pair();

    const response = await sendAttachment(
      first,
      conversationId,
      { kind: 'audio', durationMs: '7200' },
      { name: 'voice.weba', type: 'audio/webm', bytes: WEBM_AUDIO },
    );

    expect(response.status).toBe(201);
    const message = response.body.data!.message;
    expect(message.kind).toBe('audio');
    expect(message.durationMs).toBe(7200);
    expect(message.content).toBe('Voice message');
  });

  it('clamps an absurd duration rather than trusting the client', async () => {
    const { first, conversationId } = await pair();
    const response = await sendAttachment(
      first,
      conversationId,
      { kind: 'audio', durationMs: '999999999' },
      { name: 'voice.weba', type: 'audio/webm', bytes: WEBM_AUDIO },
    );
    expect(response.body.data!.message.durationMs).toBe(5 * 60 * 1000);
  });
});

describe('stickers', () => {
  it('sends an emoji as its own message kind, with no upload', async () => {
    const { first, conversationId } = await pair();
    const response = await sendAttachment(first, conversationId, { kind: 'sticker', content: '🔥' });

    expect(response.status).toBe(201);
    expect(response.body.data!.message.kind).toBe('sticker');
    expect(response.body.data!.message.content).toBe('🔥');
    expect(response.body.data!.message.mediaUrl).toBeNull();
    // A sticker is plain text: nothing reaches the bucket.
    expect(first.env.storage.objects.size).toBe(0);
  });

  it('rejects an empty sticker', async () => {
    const { first, conversationId } = await pair();
    const response = await sendAttachment(first, conversationId, { kind: 'sticker', content: '' });
    expect(response.status).toBe(400);
  });
});

describe('attachment privacy', () => {
  it('lets the recipient read it, and refuses everyone else', async () => {
    const { first, second, conversationId } = await pair();

    const sent = await sendAttachment(
      first,
      conversationId,
      { kind: 'image' },
      { name: 'pixel.png', type: 'image/png', bytes: TINY_PNG },
    );
    const url = sent.body.data!.message.mediaUrl!;

    // Sender and recipient: allowed.
    expect((await first.raw(url)).status).toBe(200);
    expect((await second.raw(url)).status).toBe(200);

    // A signed-in outsider: refused.
    const outsider = new TestClient();
    Object.assign(outsider, { env: first.env });
    await outsider.register({ username: 'nosy' });
    expect((await outsider.raw(url)).status).toBe(403);

    // Anonymous: refused.
    const anon = new TestClient();
    Object.assign(anon, { env: first.env });
    expect([401, 403]).toContain((await anon.raw(url)).status);
  });

  it('refuses to attach a media id owned by somebody else', async () => {
    const { first, second, conversationId } = await pair();

    const upload = await second.upload<{ media: { id: string } }>(
      '/api/media/upload',
      { name: 'pixel.png', type: 'image/png', bytes: TINY_PNG },
      { usage: 'attachment' },
    );

    const response = await sendAttachment(first, conversationId, {
      kind: 'image',
      mediaId: upload.body.data!.media.id,
    });
    expect(response.status).toBe(400);
  });

  it('refuses an attachment to a conversation the sender is not in', async () => {
    const { conversationId, first } = await pair();

    const outsider = new TestClient();
    Object.assign(outsider, { env: first.env });
    await outsider.register({ username: 'gatecrasher' });

    const response = await sendAttachment(
      outsider,
      conversationId,
      { kind: 'image' },
      { name: 'pixel.png', type: 'image/png', bytes: TINY_PNG },
    );
    // 404, not 403: a non-member must not learn the room exists.
    expect(response.status).toBe(404);
    // And nothing was uploaded on their behalf.
    expect(first.env.storage.objects.size).toBe(0);
  });
});

describe('rich messages in the thread', () => {
  it('renders every kind server-side, so the page works without JavaScript', async () => {
    const { first, conversationId } = await pair();
    await sendAttachment(first, conversationId, { kind: 'sticker', content: '🎉' });
    await sendAttachment(
      first,
      conversationId,
      { kind: 'image' },
      { name: 'pixel.png', type: 'image/png', bytes: TINY_PNG },
    );
    await sendAttachment(
      first,
      conversationId,
      { kind: 'audio', durationMs: '5000' },
      { name: 'voice.weba', type: 'audio/webm', bytes: WEBM_AUDIO },
    );

    const page = await first.raw(`/messages/${conversationId}`, { headers: { accept: 'text/html' } });
    const html = await page.text();

    expect(html).toContain('bubble__sticker');
    expect(html).toContain('bubble__photo');
    expect(html).toContain('bubble__voice');
    expect(html).toContain('<audio');
    // And the composer offers the three ways of sending them.
    expect(html).toContain('data-emoji-panel');
    expect(html).toContain('data-photo-input');
    expect(html).toContain('data-voice-toggle');
  });

  it('lists every kind through the API with its media URL', async () => {
    const { first, second, conversationId } = await pair();
    await sendAttachment(first, conversationId, { kind: 'sticker', content: '👍' });

    const thread = await second.get<ThreadPayload>(`/api/messages/${conversationId}`);
    const kinds = thread.body.data!.items.map((m) => m.kind);
    expect(kinds).toContain('text');
    expect(kinds).toContain('sticker');
  });
});

describe('inbox search', () => {
  it('matches on display name and on handle, from the first character', async () => {
    const { first } = await pair('ana', 'benedict');

    for (const term of ['b', 'ben', 'BENEDICT']) {
      const response = await first.get<InboxPayload>(`/api/messages?q=${encodeURIComponent(term)}`);
      expect(response.body.data!.items.map((c) => c.peer.username), term).toEqual(['benedict']);
    }
  });

  it('returns nothing for a term that matches nobody', async () => {
    const { first } = await pair();
    const response = await first.get<InboxPayload>('/api/messages?q=zzzznope');
    expect(response.body.data!.items).toHaveLength(0);
    expect(response.body.data!.people).toHaveLength(0);
  });

  it('suggests people the viewer has never messaged', async () => {
    const { first } = await pair('ana', 'ben');

    const other = new TestClient();
    Object.assign(other, { env: first.env });
    await other.register({ username: 'carol' });

    const response = await first.get<InboxPayload>('/api/messages?q=car');
    expect(response.body.data!.items).toHaveLength(0);
    expect(response.body.data!.people.map((p) => p.username)).toEqual(['carol']);
  });

  it('treats LIKE wildcards as literal characters', async () => {
    const { first } = await pair();

    // Unescaped, '%' would match every conversation and '_' every single char.
    for (const term of ['%', '_', '%%%']) {
      const response = await first.get<InboxPayload>(`/api/messages?q=${encodeURIComponent(term)}`);
      expect(response.body.data!.items, term).toHaveLength(0);
      expect(response.body.data!.people, term).toHaveLength(0);
    }
  });

  it('falls back to the full inbox when the term is empty', async () => {
    const { first } = await pair();
    const response = await first.get<InboxPayload>('/api/messages?q=');
    expect(response.body.data!.items).toHaveLength(1);
  });

  it('works without JavaScript as a plain GET form', async () => {
    const { first } = await pair('ana', 'ben');
    const page = await first.raw('/messages?q=ben', { headers: { accept: 'text/html' } });
    const html = await page.text();

    expect(page.status).toBe(200);
    expect(html).toContain('BEN');
    expect(html).toContain('data-inbox-search');
  });
});
