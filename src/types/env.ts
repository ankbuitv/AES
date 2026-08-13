/**
 * Worker bindings and runtime environment.
 *
 * Everything that is not a secret comes from `[vars]` in wrangler.toml;
 * secrets are injected by `wrangler secret put` (or `.dev.vars` locally).
 */

import type { AuthUser } from './models';

export interface Bindings {
  // --- Bindings -------------------------------------------------------------
  DB: D1Database;
  KV: KVNamespace;
  ASSETS?: Fetcher;
  /** Optional: used when STORAGE_PROVIDER === 'r2' (local dev default). */
  MEDIA_BUCKET?: R2Bucket;
  /** Optional: background job fan-out. Falls back to the D1 `jobs` table. */
  JOBS?: Queue<unknown>;

  // --- Non-secret vars ------------------------------------------------------
  ENVIRONMENT: 'development' | 'preview' | 'production';
  SITE_NAME: string;
  SITE_URL: string;
  SITE_DESCRIPTION: string;
  STORAGE_PROVIDER: 'b2' | 's3' | 'r2';
  MAX_UPLOAD_BYTES: string;
  MAX_JSON_BODY_BYTES: string;
  ALLOWED_UPLOAD_MIME: string;
  REGISTRATION_OPEN: string;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';

  // --- Secrets --------------------------------------------------------------
  SESSION_SECRET: string;
  IP_HASH_SALT?: string;

  B2_APPLICATION_KEY_ID?: string;
  B2_APPLICATION_KEY?: string;
  B2_BUCKET_ID?: string;
  B2_BUCKET_NAME?: string;
  B2_API_URL?: string;

  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
}

/** Values attached to the Hono context by middleware. */
export interface Variables {
  requestId: string;
  startTime: number;
  /** Present when a valid session cookie was supplied. */
  user: AuthUser | null;
  sessionId: string | null;
  /** CSRF token for the current session/visitor, echoed into forms + meta tag. */
  csrfToken: string | null;
  /** Stable per-request client key used by the rate limiter (user id or ip hash). */
  clientKey: string;
  clientIp: string;
  /** Per-request nonce for the Content-Security-Policy. */
  cspNonce: string;
}

export interface AppContext {
  Bindings: Bindings;
  Variables: Variables;
}

/** Cloudflare's `ExecutionContext` under a stable local name. */
/**
 * Minimal structural view of the Workers ExecutionContext.
 *
 * Declared structurally rather than as `ExecutionContext` so that Hono's own
 * (slightly narrower) execution-context type and test doubles both satisfy it.
 */
export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}
