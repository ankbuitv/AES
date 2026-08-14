/**
 * Test environment factory: a full set of Worker bindings backed by the
 * in-memory database, an in-memory KV and an in-memory storage provider.
 *
 * The point is that everything above the bindings is the *real* code — the
 * same Hono app, middleware chain, services and repositories that run in
 * production.
 */

import { createEmptyDatabase, createTestDatabase, FakeD1, FakeKV } from './d1';
import type { Bindings } from '../../src/types/env';
import type {
  GetObjectResult,
  ObjectMetadata,
  PutObjectInput,
  PutObjectResult,
  StorageProvider,
} from '../../src/services/storage';
import { getStorage } from '../../src/services/storageFactory';

/** In-memory StorageProvider: exercises the same interface as B2/S3/R2. */
export class MemoryStorage implements StorageProvider {
  readonly name = 'r2' as const;
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  /** Set to make the next call throw, for failure-path tests. */
  failNext: Error | null = null;

  private check(): void {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
  }

  async uploadObject(input: PutObjectInput): Promise<PutObjectResult> {
    this.check();
    const bytes = input.body instanceof Uint8Array ? input.body : new Uint8Array(input.body);
    this.objects.set(input.key, { bytes, contentType: input.contentType });
    return { key: input.key, size: bytes.byteLength, etag: `"${bytes.byteLength}"` };
  }

  async downloadObject(key: string): Promise<GetObjectResult | null> {
    this.check();
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(object.bytes);
          controller.close();
        },
      }),
      size: object.bytes.byteLength,
      contentType: object.contentType,
      etag: `"${object.bytes.byteLength}"`,
    };
  }

  async headObject(key: string): Promise<ObjectMetadata | null> {
    this.check();
    const object = this.objects.get(key);
    if (!object) return null;
    return { key, size: object.bytes.byteLength, contentType: object.contentType };
  }

  async getObjectMetadata(key: string): Promise<ObjectMetadata | null> {
    return this.headObject(key);
  }

  async objectExists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async deleteObject(key: string): Promise<void> {
    this.check();
    this.objects.delete(key);
  }

  async healthCheck(): Promise<void> {
    this.check();
  }
}

export interface TestEnv {
  bindings: Bindings;
  db: FakeD1;
  kv: FakeKV;
  storage: MemoryStorage;
}

export function createTestEnv(
  overrides: Partial<Bindings> = {},
  options: { empty?: boolean } = {},
): TestEnv {
  const db = options.empty ? createEmptyDatabase() : createTestDatabase();
  const kv = new FakeKV();
  const storage = new MemoryStorage();

  const bindings = {
    DB: db as unknown as D1Database,
    KV: kv as unknown as KVNamespace,
    ENVIRONMENT: 'development',
    SITE_NAME: 'AES Test',
    SITE_URL: 'http://localhost:8787',
    SITE_DESCRIPTION: 'Test instance',
    STORAGE_PROVIDER: 'r2',
    MAX_UPLOAD_BYTES: '1048576',
    MAX_JSON_BODY_BYTES: '262144',
    ALLOWED_UPLOAD_MIME: 'image/jpeg,image/png,image/webp,image/gif',
    REGISTRATION_OPEN: 'true',
    LOG_LEVEL: 'error',
    SESSION_SECRET: 'test-session-secret-value-0123456789',
    IP_HASH_SALT: 'test-ip-salt',
    ...overrides,
  } as Bindings;

  // The storage factory caches per-bindings object; pre-seed it with the
  // in-memory provider so services resolve it without touching the network.
  const cached = getStorage as unknown as { __cache?: WeakMap<object, StorageProvider> };
  void cached;
  (bindings as unknown as { MEDIA_BUCKET: unknown }).MEDIA_BUCKET = memoryBucket(storage);

  return { bindings, db, kv, storage };
}

/**
 * Minimal R2Bucket facade over MemoryStorage, so `STORAGE_PROVIDER=r2` (the
 * default) resolves through the real `R2StorageProvider` adapter rather than
 * bypassing it.
 */
function memoryBucket(storage: MemoryStorage) {
  return {
    async put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
      if (storage.failNext) {
        const error = storage.failNext;
        storage.failNext = null;
        throw error;
      }
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      storage.objects.set(key, {
        bytes,
        contentType: options?.httpMetadata?.contentType ?? 'application/octet-stream',
      });
      return { size: bytes.byteLength, httpEtag: `"${bytes.byteLength}"`, version: 'v1' };
    },
    async get(key: string, options?: { range?: { offset?: number; length?: number } }) {
      // `failNext` covers reads too, so a test can simulate a bucket outage on
      // the serving path and not just on upload.
      if (storage.failNext) {
        const error = storage.failNext;
        storage.failNext = null;
        throw error;
      }
      const object = storage.objects.get(key);
      if (!object) return null;
      const offset = options?.range?.offset ?? 0;
      const length = options?.range?.length ?? object.bytes.byteLength - offset;
      const slice = object.bytes.subarray(offset, offset + length);
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(slice);
            controller.close();
          },
        }),
        size: slice.byteLength,
        httpEtag: `"${object.bytes.byteLength}"`,
        httpMetadata: { contentType: object.contentType },
        uploaded: new Date(),
        customMetadata: {},
      };
    },
    async head(key: string) {
      const object = storage.objects.get(key);
      if (!object) return null;
      return {
        size: object.bytes.byteLength,
        httpEtag: `"${object.bytes.byteLength}"`,
        httpMetadata: { contentType: object.contentType },
        uploaded: new Date(),
        customMetadata: {},
      };
    },
    async delete(key: string) {
      storage.objects.delete(key);
    },
  };
}

/** A 1×1 PNG — the smallest byte sequence that passes MIME sniffing. */
export const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);
