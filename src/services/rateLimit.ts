/**
 * Rate limiting.
 *
 * Workers have no shared memory between isolates, so counters live in KV.
 * KV is eventually consistent, which means the limiter is approximate under a
 * burst spread across colos — that is an accepted trade-off documented in the
 * README: it protects against abuse and accidental hammering, and the strict
 * guarantees that matter (auth throttling) are additionally backed by a
 * per-account counter in D1-free KV keys that include the account id.
 *
 * Algorithm: fixed window with a rolling carry-over. Each key stores
 * `{ w: windowStart, c: countInWindow, p: countInPreviousWindow }` and the
 * effective rate is `p * overlap + c`, i.e. an approximate sliding window that
 * costs one KV read + one KV write instead of a sorted set.
 */

import { AppError } from '../utils/errors';
import { now } from '../utils/time';

export interface RateLimitTier {
  /** Human-readable name used in logs and error details. */
  name: string;
  /** Allowed requests per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

/**
 * Tiers are deliberately coarse. Anonymous traffic is cheapest to abuse, so it
 * is tightest; authenticated writes are looser; auth endpoints are tightest of
 * all because they guard credentials.
 */
export const RATE_TIERS = {
  /** Any GET from an anonymous visitor. */
  publicRead: { name: 'public_read', limit: 240, windowSeconds: 60 },
  /** Any GET from a signed-in member. */
  authedRead: { name: 'authed_read', limit: 600, windowSeconds: 60 },
  /** Generic authenticated mutation (profile edits, reactions, follows…). */
  write: { name: 'write', limit: 60, windowSeconds: 60 },
  /** Content creation is heavier: posts and comments. */
  createPost: { name: 'create_post', limit: 10, windowSeconds: 300 },
  createComment: { name: 'create_comment', limit: 30, windowSeconds: 300 },
  /** Credential endpoints. */
  login: { name: 'login', limit: 8, windowSeconds: 900 },
  register: { name: 'register', limit: 5, windowSeconds: 3600 },
  passwordReset: { name: 'password_reset', limit: 5, windowSeconds: 3600 },
  /** Uploads are expensive in bandwidth and storage. */
  upload: { name: 'upload', limit: 20, windowSeconds: 3600 },
  /** Search hits FTS5 and is comparatively costly. */
  search: { name: 'search', limit: 60, windowSeconds: 60 },
  /** Chat: chattier than a generic write, still bounded. */
  sendMessage: { name: 'send_message', limit: 120, windowSeconds: 60 },
  /** Reports: prevent moderation-queue flooding. */
  report: { name: 'report', limit: 10, windowSeconds: 3600 },
} as const satisfies Record<string, RateLimitTier>;

export type RateTierName = keyof typeof RATE_TIERS;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds when the window resets. */
  resetAt: number;
  retryAfter: number;
}

interface Bucket {
  w: number;
  c: number;
  p: number;
}

const KEY_PREFIX = 'rl:';

/**
 * Consume one unit from the bucket identified by `tier` + `identity`.
 * Never throws on KV failure: availability beats strictness for a limiter.
 */
export async function consume(
  kv: KVNamespace,
  tier: RateLimitTier,
  identity: string,
  cost = 1,
): Promise<RateLimitResult> {
  const ts = now();
  const windowStart = ts - (ts % tier.windowSeconds);
  const key = `${KEY_PREFIX}${tier.name}:${identity}`;

  let bucket: Bucket = { w: windowStart, c: 0, p: 0 };
  try {
    const stored = await kv.get<Bucket>(key, 'json');
    if (stored && typeof stored.w === 'number') {
      if (stored.w === windowStart) {
        bucket = stored;
      } else if (stored.w === windowStart - tier.windowSeconds) {
        bucket = { w: windowStart, c: 0, p: stored.c };
      }
    }
  } catch {
    // KV read failed — fail open rather than locking everyone out.
    return {
      allowed: true,
      limit: tier.limit,
      remaining: tier.limit,
      resetAt: windowStart + tier.windowSeconds,
      retryAfter: 0,
    };
  }

  // Weight the previous window by how much of it still overlaps "now".
  const elapsed = ts - windowStart;
  const overlap = Math.max(0, 1 - elapsed / tier.windowSeconds);
  const effective = bucket.p * overlap + bucket.c;

  const resetAt = windowStart + tier.windowSeconds;

  if (effective + cost > tier.limit) {
    return {
      allowed: false,
      limit: tier.limit,
      remaining: 0,
      resetAt,
      retryAfter: Math.max(1, resetAt - ts),
    };
  }

  bucket.c += cost;
  try {
    await kv.put(key, JSON.stringify(bucket), {
      // Keep one extra window so the carry-over term can be computed.
      expirationTtl: tier.windowSeconds * 2 + 60,
    });
  } catch {
    // Ignore write failures; the read above already bounded the damage.
  }

  return {
    allowed: true,
    limit: tier.limit,
    remaining: Math.max(0, Math.floor(tier.limit - effective - cost)),
    resetAt,
    retryAfter: 0,
  };
}

/** Consume and throw a 429 (with Retry-After details) when exhausted. */
export async function enforce(
  kv: KVNamespace,
  tier: RateLimitTier,
  identity: string,
  cost = 1,
): Promise<RateLimitResult> {
  const result = await consume(kv, tier, identity, cost);
  if (!result.allowed) {
    throw AppError.rateLimited(
      result.retryAfter,
      'Too many requests. Please slow down and try again shortly.',
    );
  }
  return result;
}

/** Standard rate-limit headers, attached to every limited response. */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.resetAt),
  };
  if (!result.allowed) headers['Retry-After'] = String(result.retryAfter);
  return headers;
}

/**
 * Clear a bucket — used after a successful login so a member who fumbled their
 * password twice is not punished for the rest of the window.
 */
export async function reset(
  kv: KVNamespace,
  tier: RateLimitTier,
  identity: string,
): Promise<void> {
  try {
    await kv.delete(`${KEY_PREFIX}${tier.name}:${identity}`);
  } catch {
    // Non-fatal.
  }
}
