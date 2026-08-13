/**
 * Chooses the storage backend from configuration.
 * Callers receive a `StorageProvider` and stay unaware of which one it is.
 */

import type { Bindings } from '../types/env';
import type { StorageProvider } from './storage';
import { B2StorageProvider } from './b2';
import { S3StorageProvider } from './s3';
import { R2StorageProvider } from './r2';
import { AppError } from '../utils/errors';

const cache = new WeakMap<Bindings, StorageProvider>();

export function getStorage(env: Bindings): StorageProvider {
  const cached = cache.get(env);
  if (cached) return cached;

  const provider = build(env);
  cache.set(env, provider);
  return provider;
}

function build(env: Bindings): StorageProvider {
  const kind = env.STORAGE_PROVIDER ?? 'r2';

  switch (kind) {
    case 'b2':
      if (
        !env.B2_APPLICATION_KEY_ID ||
        !env.B2_APPLICATION_KEY ||
        !env.B2_BUCKET_ID ||
        !env.B2_BUCKET_NAME
      ) {
        // Production can keep STORAGE_PROVIDER=b2 in wrangler.toml while a
        // MEDIA_BUCKET binding is present (local/preview). Prefer a working
        // backend over a constructor throw that reports a false outage.
        if (env.MEDIA_BUCKET) return new R2StorageProvider(env.MEDIA_BUCKET);
        throw AppError.storage('B2 credentials are not configured');
      }
      return new B2StorageProvider(
        {
          applicationKeyId: env.B2_APPLICATION_KEY_ID,
          applicationKey: env.B2_APPLICATION_KEY,
          bucketId: env.B2_BUCKET_ID,
          bucketName: env.B2_BUCKET_NAME,
          apiUrl: env.B2_API_URL,
        },
        env.KV,
      );

    case 's3':
      if (!env.S3_ENDPOINT || !env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
        if (env.MEDIA_BUCKET) return new R2StorageProvider(env.MEDIA_BUCKET);
        throw AppError.storage('S3 storage is not configured');
      }
      return new S3StorageProvider({
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION ?? 'us-east-1',
        bucket: env.S3_BUCKET,
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        forcePathStyle: true,
      });

    case 'r2':
      if (!env.MEDIA_BUCKET) {
        throw AppError.storage('STORAGE_PROVIDER=r2 but no MEDIA_BUCKET binding is configured');
      }
      return new R2StorageProvider(env.MEDIA_BUCKET);

    default:
      throw AppError.storage(`Unknown storage provider: ${String(kind)}`);
  }
}

/** Health probe used by /health and the admin dashboard. */
export async function checkStorageHealth(
  env: Bindings,
): Promise<{ ok: boolean; provider: string; error?: string }> {
  try {
    const storage = getStorage(env);
    await storage.healthCheck();
    return { ok: true, provider: storage.name };
  } catch (error) {
    return {
      ok: false,
      provider: env.STORAGE_PROVIDER ?? 'unknown',
      error: error instanceof Error ? error.message : 'unknown error',
    };
  }
}
