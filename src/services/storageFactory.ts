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
      return new B2StorageProvider(
        {
          applicationKeyId: env.B2_APPLICATION_KEY_ID ?? '',
          applicationKey: env.B2_APPLICATION_KEY ?? '',
          bucketId: env.B2_BUCKET_ID ?? '',
          bucketName: env.B2_BUCKET_NAME ?? '',
          apiUrl: env.B2_API_URL,
        },
        env.KV,
      );

    case 's3':
      return new S3StorageProvider({
        endpoint: env.S3_ENDPOINT ?? '',
        region: env.S3_REGION ?? 'us-east-1',
        bucket: env.S3_BUCKET ?? '',
        accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
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
    // HEAD on a key that will not exist: proves credentials + reachability
    // without creating garbage objects.
    await storage.headObject('.health/probe');
    return { ok: true, provider: storage.name };
  } catch (error) {
    return {
      ok: false,
      provider: env.STORAGE_PROVIDER ?? 'unknown',
      error: error instanceof Error ? error.message : 'unknown error',
    };
  }
}
