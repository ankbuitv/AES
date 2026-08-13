/**
 * Cloudflare R2 adapter.
 *
 * Used as the local-development default because `wrangler dev` simulates R2 on
 * disk with zero credentials, so `npm run dev` works before any Backblaze
 * account exists. It is also a valid production choice — the interface is
 * identical, so switching is a `STORAGE_PROVIDER` change.
 */

import type {
  GetObjectResult,
  ObjectMetadata,
  PutObjectInput,
  PutObjectResult,
  StorageProvider,
} from './storage';
import { assertSafeKey } from './storage';
import { AppError } from '../utils/errors';

export class R2StorageProvider implements StorageProvider {
  readonly name = 'r2' as const;

  constructor(private readonly bucket: R2Bucket) {
    if (!bucket) throw AppError.storage('R2 bucket binding is missing');
  }

  async uploadObject(input: PutObjectInput): Promise<PutObjectResult> {
    assertSafeKey(input.key);
    const bytes = input.body instanceof Uint8Array ? input.body : new Uint8Array(input.body);
    const object = await this.bucket.put(input.key, bytes as unknown as ArrayBuffer, {
      httpMetadata: { contentType: input.contentType || 'application/octet-stream' },
      customMetadata: input.metadata,
    });
    return {
      key: input.key,
      size: object?.size ?? bytes.byteLength,
      etag: object?.httpEtag,
      versionId: object?.version,
    };
  }

  async downloadObject(key: string, range?: string): Promise<GetObjectResult | null> {
    assertSafeKey(key);
    const parsedRange = range ? parseRange(range) : undefined;
    const object = await this.bucket.get(key, parsedRange ? { range: parsedRange } : undefined);
    if (!object || !object.body) return null;

    return {
      body: object.body as ReadableStream<Uint8Array>,
      size: object.size,
      contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
      etag: object.httpEtag,
      lastModified: object.uploaded ? Math.floor(object.uploaded.getTime() / 1000) : undefined,
      metadata: object.customMetadata,
    };
  }

  async headObject(key: string): Promise<ObjectMetadata | null> {
    assertSafeKey(key);
    const object = await this.bucket.head(key);
    if (!object) return null;
    return {
      key,
      size: object.size,
      contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
      etag: object.httpEtag,
      lastModified: object.uploaded ? Math.floor(object.uploaded.getTime() / 1000) : undefined,
      metadata: object.customMetadata,
    };
  }

  async getObjectMetadata(key: string): Promise<ObjectMetadata | null> {
    return this.headObject(key);
  }

  async objectExists(key: string): Promise<boolean> {
    return (await this.bucket.head(key)) !== null;
  }

  async deleteObject(key: string): Promise<void> {
    assertSafeKey(key);
    await this.bucket.delete(key);
  }
}

function parseRange(range: string): { offset: number; length?: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) return undefined;
  const start = match[1] ? Number(match[1]) : undefined;
  const end = match[2] ? Number(match[2]) : undefined;
  if (start === undefined && end === undefined) return undefined;
  if (start === undefined && end !== undefined) return { offset: 0, length: end };
  if (start !== undefined && end === undefined) return { offset: start };
  return { offset: start!, length: end! - start! + 1 };
}
