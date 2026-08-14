/**
 * Reels: URL parsing, import, the self-hosted upload path, the public feed,
 * likes and deletion.
 *
 * The parser gets the most attention because it is the security boundary of the
 * feature: whatever it returns ends up in an `<iframe src>`, so the tests assert
 * that the embed URL is *rebuilt* from a validated id rather than echoed back
 * from the pasted string, and that anything unrecognised is refused outright.
 */

import { describe, expect, it } from 'vitest';
import { TestClient } from './helpers/client';
import { parseReelUrl, playableEmbedUrl, posterFor } from '../src/services/reelSources';
import { contentSecurityPolicy } from '../src/middleware/security';

interface ReelPayload {
  reel: {
    id: string;
    provider: string;
    providerLabel: string;
    externalId: string;
    sourceUrl: string;
    embedUrl: string;
    videoUrl: string;
    posterUrl: string;
    caption: string;
    likeCount: number;
    viewerLiked: boolean;
    canDelete: boolean;
  };
}

interface FeedPayload {
  items: ReelPayload['reel'][];
  nextCursor: string | null;
  hasMore: boolean;
}

/** A minimal but genuine WebM/Matroska header, for the upload sniffer. */
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Array(128).fill(0)]);

async function authed(username = 'reeler') {
  const client = new TestClient();
  await client.register({ username });
  return client;
}

describe('reel URL parsing', () => {
  it('reads a YouTube Shorts link and builds a no-cookie embed', () => {
    const parsed = parseReelUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ');
    expect(parsed?.provider).toBe('youtube');
    expect(parsed?.externalId).toBe('dQw4w9WgXcQ');
    expect(parsed?.embedUrl).toContain('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  });

  it('accepts every common YouTube shape', () => {
    for (const url of [
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://m.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    ]) {
      expect(parseReelUrl(url)?.externalId, url).toBe('dQw4w9WgXcQ');
    }
  });

  it('reads TikTok, Instagram and Facebook links', () => {
    const tiktok = parseReelUrl('https://www.tiktok.com/@someone/video/7301234567890123456');
    expect(tiktok?.provider).toBe('tiktok');
    expect(tiktok?.embedUrl).toBe('https://www.tiktok.com/embed/v2/7301234567890123456');

    const instagram = parseReelUrl('https://www.instagram.com/reel/Cx1AbCdEfGh/');
    expect(instagram?.provider).toBe('instagram');
    expect(instagram?.embedUrl).toContain('/reel/Cx1AbCdEfGh/embed');

    const facebook = parseReelUrl('https://www.facebook.com/reel/1234567890123');
    expect(facebook?.provider).toBe('facebook');
    expect(facebook?.embedUrl).toContain('plugins/video.php');
  });

  it('refuses anything that is not a supported platform', () => {
    for (const url of [
      'https://vimeo.com/12345',
      'https://evil.example/steal',
      'not a url at all',
      'https://www.youtube.com/',
      // Look-alike hostnames must not be accepted by a suffix match.
      'https://youtube.com.evil.example/shorts/dQw4w9WgXcQ',
    ]) {
      expect(parseReelUrl(url), url).toBeNull();
    }
  });

  it('never lets a non-http scheme through, so an embed cannot become script', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
    ]) {
      expect(parseReelUrl(url), url).toBeNull();
    }
  });

  it('adds autoplay to the on-screen player URL without changing the stored embed', () => {
    const parsed = parseReelUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ');
    expect(parsed?.embedUrl).not.toContain('autoplay=1');
    expect(playableEmbedUrl(parsed!.embedUrl)).toContain('autoplay=1');
    expect(playableEmbedUrl(parsed!.embedUrl)).toContain('mute=1');
  });

  it('builds the embed from the id, so query junk on the paste is discarded', () => {
    const parsed = parseReelUrl(
      'https://www.youtube.com/shorts/dQw4w9WgXcQ?utm_source=evil&"onload="alert(1)',
    );
    expect(parsed?.embedUrl).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&modestbranding=1&playsinline=1',
    );
    expect(parsed?.embedUrl).not.toContain('alert');
  });

  it('only offers a poster where the platform exposes a stable one', () => {
    expect(posterFor('youtube', 'dQw4w9WgXcQ')).toContain('i.ytimg.com');
    expect(posterFor('tiktok', '7301234567890123456')).toBe('');
  });
});

describe('importing reels', () => {
  it('stores an embed without copying the video', async () => {
    const client = await authed();
    const response = await client.post<ReelPayload>('/api/reels/import', {
      url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      caption: 'Worth a watch',
    });

    expect(response.status).toBe(201);
    const reel = response.body.data!.reel;
    expect(reel.provider).toBe('youtube');
    expect(reel.caption).toBe('Worth a watch');
    // Nothing self-hosted: no media row, no bucket object.
    expect(reel.videoUrl).toBe('');
    expect(client.env.storage.objects.size).toBe(0);
  });

  it('returns the existing reel instead of duplicating an import', async () => {
    const client = await authed();
    const url = 'https://www.tiktok.com/@someone/video/7301234567890123456';
    const first = await client.post<ReelPayload>('/api/reels/import', { url });
    const second = await client.post<ReelPayload>('/api/reels/import', { url });

    expect(second.body.data!.reel.id).toBe(first.body.data!.reel.id);
    const feed = await client.get<FeedPayload>('/api/reels');
    expect(feed.body.data!.items).toHaveLength(1);
  });

  it('rejects an unsupported link with a helpful message', async () => {
    const client = await authed();
    const response = await client.post('/api/reels/import', { url: 'https://vimeo.com/12345' });
    expect(response.status).toBe(400);
    expect(response.body.error?.message).toMatch(/YouTube Shorts, TikTok, Instagram or Facebook/);
  });

  it('requires a session', async () => {
    const client = new TestClient();
    await client.get('/login', { headers: { accept: 'text/html' } });
    const response = await client.post('/api/reels/import', {
      url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    });
    expect(response.status).toBe(401);
  });
});

describe('uploaded reels', () => {
  it('publishes a video from the member’s own media library', async () => {
    const client = await authed();
    const upload = await client.upload<{ media: { id: string } }>(
      '/api/media/upload',
      { name: 'clip.webm', type: 'video/webm', bytes: WEBM },
      { usage: 'post' },
    );
    expect(upload.status).toBe(201);

    const response = await client.post<ReelPayload>('/api/reels', {
      mediaId: upload.body.data!.media.id,
      caption: 'My own clip',
    });

    expect(response.status).toBe(201);
    const reel = response.body.data!.reel;
    expect(reel.provider).toBe('upload');
    expect(reel.videoUrl).toBe(`/media/${upload.body.data!.media.id}`);
    expect(reel.embedUrl).toBe('');
  });

  it('refuses a media id belonging to someone else', async () => {
    const owner = await authed('owner');
    const upload = await owner.upload<{ media: { id: string } }>(
      '/api/media/upload',
      { name: 'clip.webm', type: 'video/webm', bytes: WEBM },
      { usage: 'post' },
    );

    const stranger = new TestClient();
    Object.assign(stranger, { env: owner.env });
    await stranger.register({ username: 'stranger' });

    const response = await stranger.post('/api/reels', {
      mediaId: upload.body.data!.media.id,
    });
    expect(response.status).toBe(400);
  });

  it('refuses a still image dressed up as a reel', async () => {
    const client = await authed();
    const { TINY_PNG } = await import('./helpers/env');
    const upload = await client.upload<{ media: { id: string } }>(
      '/api/media/upload',
      { name: 'pixel.png', type: 'image/png', bytes: TINY_PNG },
      { usage: 'post' },
    );

    const response = await client.post('/api/reels', { mediaId: upload.body.data!.media.id });
    expect(response.status).toBe(400);
    expect(response.body.error?.message).toMatch(/video/i);
  });
});

describe('the reel feed', () => {
  it('is readable by anonymous visitors and pages with a cursor', async () => {
    const client = await authed();
    for (const id of ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']) {
      await client.post('/api/reels/import', { url: `https://youtu.be/${id}` });
    }

    const anon = new TestClient();
    Object.assign(anon, { env: client.env });

    const first = await anon.get<FeedPayload>('/api/reels?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.data!.items).toHaveLength(2);
    expect(first.body.data!.hasMore).toBe(true);

    const second = await anon.get<FeedPayload>(
      `/api/reels?limit=2&cursor=${encodeURIComponent(first.body.data!.nextCursor!)}`,
    );
    expect(second.body.data!.items).toHaveLength(1);
    // No overlap between the pages.
    const ids = new Set(first.body.data!.items.map((r) => r.id));
    expect(ids.has(second.body.data!.items[0]!.id)).toBe(false);
  });

  it('never caches a signed-in response in a shared cache', async () => {
    const client = await authed();
    const response = await client.get('/api/reels');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('server-renders /reels with the platform iframe', async () => {
    const client = await authed();
    await client.post('/api/reels/import', { url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ' });

    const page = await client.raw('/reels', { headers: { accept: 'text/html' } });
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
  });
});

describe('reel likes and deletion', () => {
  it('toggles a like and keeps the count consistent', async () => {
    const client = await authed();
    const created = await client.post<ReelPayload>('/api/reels/import', {
      url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    });
    const id = created.body.data!.reel.id;

    const on = await client.post<{ liked: boolean; likeCount: number }>(`/api/reels/${id}/like`);
    expect(on.body.data).toEqual({ liked: true, likeCount: 1 });

    // A repeated like is idempotent in the join table, so the count cannot drift.
    const off = await client.post<{ liked: boolean; likeCount: number }>(`/api/reels/${id}/like`);
    expect(off.body.data).toEqual({ liked: false, likeCount: 0 });
  });

  it('lets the author delete a reel and hides it from the feed afterwards', async () => {
    const client = await authed();
    const created = await client.post<ReelPayload>('/api/reels/import', {
      url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    });
    const id = created.body.data!.reel.id;

    expect((await client.delete(`/api/reels/${id}`)).status).toBe(204);
    const feed = await client.get<FeedPayload>('/api/reels');
    expect(feed.body.data!.items).toHaveLength(0);
    expect((await client.get(`/api/reels/${id}`)).status).toBe(404);
  });

  it('does not let a stranger delete someone else’s reel', async () => {
    const author = await authed('author');
    const created = await author.post<ReelPayload>('/api/reels/import', {
      url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    });

    const stranger = new TestClient();
    Object.assign(stranger, { env: author.env });
    await stranger.register({ username: 'nosy' });

    const response = await stranger.delete(`/api/reels/${created.body.data!.reel.id}`);
    expect(response.status).toBe(403);
  });
});

describe('content security policy', () => {
  it('allows exactly the embed hosts reels need, and nothing else', () => {
    const csp = contentSecurityPolicy('nonce123', 'https://aes.example');
    const frameSrc = csp.split('; ').find((part) => part.startsWith('frame-src '));

    expect(frameSrc).toBeDefined();
    expect(frameSrc).toContain('https://www.youtube-nocookie.com');
    expect(frameSrc).toContain('https://www.tiktok.com');
    expect(frameSrc).toContain('https://www.instagram.com');
    expect(frameSrc).toContain('https://www.facebook.com');
    // No blanket wildcard, and framing *us* is still forbidden.
    expect(frameSrc).not.toContain('*');
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
