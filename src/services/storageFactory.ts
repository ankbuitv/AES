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

/**
 * Config-gap marker. A missing credential or binding is NOT an outage: the
 * bucket was never reachable (or stopped being configured), so reporting it as
 * a 0 ms "storage unavailable" incident is a false alarm and gives an operator
 * no way to tell "fix the secrets" from "B2 is down".
 *
 * `checkStorageHealth` maps these to the `missing` state (like an unapplied
 * schema), so the status page can say "Not configured" instead of "Unavailable".
 */
function notConfigured(message: string): AppError {
  return new AppError('STORAGE_ERROR', message, { details: { reason: 'not_configured' } });
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
        throw notConfigured(
          'B2 storage is not configured: set B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY, ' +
            'B2_BUCKET_ID and B2_BUCKET_NAME on the Worker, or bind MEDIA_BUCKET.',
        );
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
        throw notConfigured(
          'S3 storage is not configured: set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and ' +
            'S3_SECRET_ACCESS_KEY on the Worker, or bind MEDIA_BUCKET.',
        );
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
        throw notConfigured('STORAGE_PROVIDER=r2 but no MEDIA_BUCKET binding is configured');
      }
      return new R2StorageProvider(env.MEDIA_BUCKET);

    default:
      throw notConfigured(`Unknown storage provider: ${String(kind)}`);
  }
}

export type StorageHealthState = 'ok' | 'missing' | 'error';

export interface StorageHealthResult {
  ok: boolean;
  state: StorageHealthState;
  provider: string;
  /** Public-safe reason, present when the check failed. Never includes secrets. */
  error?: string;
}

/**
 * Health probe used by /health and the admin dashboard.
 *
 * Failure is classified so operators can act on it:
 *  - `missing` — the provider cannot even be constructed (credentials or a
 *    bucket binding are absent). A configuration gap, not an outage.
 *  - `error` — the provider is configured but the backend is unreachable or
 *    rejects the probe.
 */
export async function checkStorageHealth(env: Bindings): Promise<StorageHealthResult> {
  try {
    const storage = getStorage(env);
    await storage.healthCheck();
    return { ok: true, state: 'ok', provider: storage.name };
  } catch (error) {
    const isConfigGap = error instanceof AppError && error.details?.reason === 'not_configured';
    return {
      ok: false,
      state: isConfigGap ? 'missing' : 'error',
      provider: env.STORAGE_PROVIDER ?? 'unknown',
      error: error instanceof Error ? error.message : 'unknown error',
    };
  }
}
