/**
 * Media pipeline and the storage abstraction.
 *
 * Covers the upload gate (size, sniffed MIME, dangerous payloads), the
 * permission-checked read path, deletion with cleanup, and the StorageProvider
 * contract itself — including a provider failure, so we know a bucket outage
 * does not corrupt the database.
 */

import { describe, expect, it } from 'vitest';
import { TestClient } from './helpers/client';
import { createTestEnv, MemoryStorage, TINY_PNG } from './helpers/env';
import { generateObjectKey, assertSafeKey } from '../src/services/storage';
import { checkStorageHealth } from '../src/services/storageFactory';
import { AppError } from '../src/utils/errors';

const GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

const encoder = new TextEncoder();

interface MediaPayload {
  media: { id: string; mimeType: string; size: number; url: string; thumbUrl: string };
}

async function authed(username = 'uploader') {
  const client = new TestClient();
  await client.register({ username });
  return client;
}

describe('upload', () => {
  it('accepts a real PNG and stores only metadata in the database', async () => {
    const client = await authed();

    const result = await client.upload<MediaPayload>(
      '/api/media/upload',
      { name: 'pixel.png', type: 'image/png', bytes: TINY_PNG },
      { usage: 'attachment' },
    );

    expect(result.status).toBe(201);
    const media = result.body.data!.media;
    expect(media.mimeType).toBe('image/png');
    expect(media.url).toBe(`/media/${media.id}`);

    // The row carries a storage key, never the bytes.
    const row = client.env.db.sqlite
      .prepare('SELECT * FROM media WHERE id = ?')
      .get(media.id) as Record<string, unknown>;
    expect(row.storage_key).toBeTruthy();
    expect(Object.values(row).some((value) => value instanceof Uint8Array)).toBe(false);
  });

  it('rejects an unauthenticated upload', async () => {
    const client = new TestClient();
    await client.get('/login', { headers: { accept: 'text/html' } });
    const result = await client.upload('/api/media/upload', {
      name: 'pixel.png',
      type: 'image/png',
      bytes: TINY_PNG,
    });
    expect(result.status).toBe(401);
  });

  it('rejects a file that is too large', async () => {
    const client = await authed('bigfiles');
    // MAX_UPLOAD_BYTES is 1 MiB in the test environment.
    const oversized = new Uint8Array(1_200_000);
    oversized.set(TINY_PNG, 0);

    const result = await client.upload('/api/media/upload', {
      name: 'huge.png',
      type: 'image/png',
      bytes: oversized,
    });
    expect([400, 413]).toContain(result.status);
  });

  it('rejects a PHP file even when it claims to be an image', async () => {
    const client = await authed('phphacker');
    const result = await client.upload('/api/media/upload', {
      name: 'shell.png',
      type: 'image/png',
      bytes: encoder.encode('<?php system($_GET["c"]); ?>'),
    });
    expect(result.status).toBe(415);
    expect(result.body.error?.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects HTML and SVG payloads', async () => {
    const client = await authed('markuper');

    const html = await client.upload('/api/media/upload', {
      name: 'page.png',
      type: 'image/png',
      bytes: encoder.encode('<!doctype html><html><script>alert(1)</script></html>'),
    });
    expect(html.status).toBe(415);

    const svg = await client.upload('/api/media/upload', {
      name: 'vector.svg',
      type: 'image/svg+xml',
      bytes: encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    });
    expect(svg.status).toBe(415);
  });

  it('rejects an executable', async () => {
    const client = await authed('binaryman');
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0, 0, 0, 0]);
    const result = await client.upload('/api/media/upload', {
      name: 'payload.png',
      type: 'image/png',
      bytes: elf,
    });
    expect(result.status).toBe(415);
  });

  it('rejects a declared type that disagrees with the bytes', async () => {
    const client = await authed('liar');
    const result = await client.upload('/api/media/upload', {
      name: 'actually.gif',
      type: 'image/jpeg',
      bytes: GIF,
    });
    expect(result.status).toBe(415);
  });

  it('deduplicates identical bytes for the same owner', async () => {
    const client = await authed('duper');

    const first = await client.upload<MediaPayload>('/api/media/upload', {
      name: 'a.png',
      type: 'image/png',
      bytes: TINY_PNG,
    });
    const second = await client.upload<MediaPayload>('/api/media/upload', {
      name: 'b.png',
      type: 'image/png',
      bytes: TINY_PNG,
    });

    expect(second.body.data!.media.id).toBe(first.body.data!.media.id);
  });

  it('surfaces the operator-facing message when storage is unconfigured', async () => {
    const client = new TestClient({ STORAGE_PROVIDER: 'b2' });
    // Remove the local R2 fallback so the b2 provider is genuinely unconfigured.
    delete (client.bindings as unknown as Record<string, unknown>).MEDIA_BUCKET;
    await client.register({ username: 'noconfig' });

    const result = await client.upload('/api/media/upload', {
      name: 'pixel.png',
      type: 'image/png',
      bytes: TINY_PNG,
    });

    expect(result.status).toBe(502);
    expect(result.body.error?.code).toBe('STORAGE_ERROR');
    // A configuration gap is actionable, unlike a generic 5xx: the person
    // holding the keyboard needs the missing-variable hint, not "Something
    // went wrong".
    expect(result.body.error?.message).toContain('B2 storage is not configured');
  });
});

describe('serving', () => {
  it('streams the object with nosniff and a restrictive CSP', async () => {
    const client = await authed('server');
    const upload = await client.upload<MediaPayload>('/api/media/upload', {
      name: 'pixel.png',
      type: 'image/png',
      bytes: TINY_PNG,
    });
    const id = upload.body.data!.media.id;

    const response = await client.raw(`/media/${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('cache-control')).toBeTruthy();

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBe(TINY_PNG.byteLength);
  });

  it('answers 304 for a matching ETag', async () => {
    const client = await authed('etagger');
    const upload = await client.upload<MediaPayload>('/api/media/upload', {
      name: 'pixel.png',
      type: 'image/png',
      bytes: TINY_PNG,
    });
    const id = upload.body.data!.media.id;

    const first = await client.raw(`/media/${id}`);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    const second = await client.raw(`/media/${id}`, { headers: { 'if-none-match': etag! } });
    expect(second.status).toBe(304);
  });

  it('supports range requests', async () => {
    const client = await authed('ranger');
    const upload = await client.upload<MediaPayload>('/api/media/upload', {
      name: 'pixel.png',
      type: 'image/png',
      bytes: TINY_PNG,
    });
    const id = upload.body.data!.media.id;

    const response = await client.raw(`/media/${id}`, { headers: { range: 'bytes=0-9' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toMatch(/^bytes 0-9\//);
  });

  it('returns 404 for an unknown id', async () => {
    const client = new TestClient();
    const response = await client.raw('/media/med_missing0000000');
    expect(response.status).toBe(404);
  });

  it('marks a row missing when the object has vanished from the bucket', async () => {
    const client = await authed('vanisher');
    const upload = await client.upload<MediaPayload>('/api/media/upload', {
      name: 'pixel.png',
      type: 'image/png',
      bytes: TINY_PNG,
    });
    const id = upload.body.data!.media.id;

    // Delete straight from the bucket, behind the application's back.
    const key = (
      client.env.db.sqlite.prepare('SELECT storage_key FROM media WHERE id = ?').get(id) as {
        storage_key: string;
      }
    ).storage_key;
    client.env.storage.objects.delete(key);

    const response = await client.raw(`/media/${id}`);
    expect(response.status).toBeGreaterThanOrEqual(404);

    const status = (
      client.env.db.sqlite.prepare('SELECT status FROM media WHERE id = ?').get(id) as {
        status: string;
      }
    ).status;
    expect(status).toBe('missing');
  });
});

describe('deletion', () => {
  it('lets the owner delete and refuses a stranger', async () => {
    const owner = await authed('mediaowner');
    const upload = await owner.upload<MediaPayload>('/api/media/upload', {
      name: 'pixel.png',
      type: 'image/png',
      bytes: TINY_PNG,
    });
    const id = upload.body.data!.media.id;

    const stranger = new TestClient();
    Object.assign(stranger, { env: owner.env });
    await stranger.register({ username: 'mediastranger' });

    expect((await stranger.delete(`/api/media/${id}`)).status).toBe(403);

    const removed = await owner.delete(`/api/media/${id}`);
    expect(removed.status).toBeLessThan(400);

    const row = owner.env.db.sqlite.prepare('SELECT status FROM media WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('deleted');

    // Soft delete queues the object for removal rather than deleting inline.
    const queued = owner.env.db.sqlite
      .prepare('SELECT COUNT(*) AS n FROM storage_cleanup_queue')
      .get() as { n: number };
    expect(queued.n).toBeGreaterThan(0);
  });
});

describe('StorageProvider contract', () => {
  it('round-trips an object through the interface', async () => {
    const storage = new MemoryStorage();
    const key = 'test/2026/object.bin';
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const put = await storage.uploadObject({ key, body: bytes, contentType: 'application/octet-stream' });
    expect(put.size).toBe(4);
    expect(await storage.objectExists(key)).toBe(true);

    const head = await storage.headObject(key);
    expect(head?.size).toBe(4);

    const got = await storage.downloadObject(key);
    expect(got).not.toBeNull();

    await storage.deleteObject(key);
    expect(await storage.objectExists(key)).toBe(false);
    expect(await storage.downloadObject(key)).toBeNull();
  });

  it('generates namespaced, collision-resistant keys', async () => {
    const a = generateObjectKey({
      usage: 'attachment',
      ownerId: 'usr_1',
      mediaId: 'med_1',
      extension: 'png',
    });
    const b = generateObjectKey({
      usage: 'attachment',
      ownerId: 'usr_1',
      mediaId: 'med_2',
      extension: 'png',
    });

    expect(a).not.toBe(b);
    expect(a).toMatch(/\.png$/);
    expect(a).toContain('usr_1');
    expect(() => assertSafeKey(a)).not.toThrow();
  });

  it('treats a missing health probe object as a healthy bucket', async () => {
    const client = new TestClient();
    const report = await checkStorageHealth(client.env.bindings);
    expect(report.ok).toBe(true);
    expect(report.state).toBe('ok');
    expect(report.provider).toBe('r2');
  });

  it('classifies an unconfigured provider as missing, not as an outage', async () => {
    const env = createTestEnv();
    const bindings = { ...env.bindings } as Record<string, unknown>;
    bindings.STORAGE_PROVIDER = 'b2';
    delete bindings.MEDIA_BUCKET;

    const report = await checkStorageHealth(bindings as never);
    expect(report.ok).toBe(false);
    expect(report.state).toBe('missing');
    expect(report.provider).toBe('b2');
    expect(report.error).toContain('B2 storage is not configured');
  });

  it('refuses a traversal key', () => {
    for (const key of ['../secrets', '/etc/passwd', 'a/../../b', '']) {
      expect(() => assertSafeKey(key)).toThrow(AppError);
    }
  });

  it('does not leave a metadata row behind when the bucket write fails', async () => {
    const client = await authed('unlucky');
    client.env.storage.failNext = new Error('bucket unreachable');

    const result = await client.upload('/api/media/upload', {
      name: 'pixel.png',
      type: 'image/png',
      bytes: TINY_PNG,
    });

    // A bucket outage is reported as an upstream failure, not a 500…
    expect(result.status).toBe(502);
    expect(result.body.error?.code).toBe('STORAGE_ERROR');
    // …and the provider's own message never reaches the client.
    expect(result.text).not.toContain('bucket unreachable');

    const rows = client.env.db.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM media WHERE status = 'ready'`)
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });
});
