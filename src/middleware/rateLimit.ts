/**
 * Rate-limit middleware.
 *
 * Wraps the KV limiter in `src/services/rateLimit.ts`. Every limited response
 * carries `X-RateLimit-*`, and a rejection is a 429 with `Retry-After` (set by
 * `jsonError`/the error handler from the `AppError` details).
 *
 * Identity is the value `requestContext`/`sessionMiddleware` computed:
 * `usr:<id>` for members, `ip:<hash>` for anonymous traffic. Auth endpoints
 * additionally mix in the submitted identifier so one attacker cannot lock a
 * victim out by burning the victim's account bucket from another IP — the
 * per-account bucket is only consumed on failure, inside the auth service.
 */

import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types/env';
import { RATE_TIERS, type RateTierName, consume, rateLimitHeaders } from '../services/rateLimit';
import { AppError } from '../utils/errors';

export const rateLimit = (tierName: RateTierName): MiddlewareHandler<AppContext> => {
  const tier = RATE_TIERS[tierName];

  return async (c, next) => {
    const result = await consume(c.env.KV, tier, c.get('clientKey'));

    if (!result.allowed) {
      // Headers are attached by the error handler via the thrown AppError, but
      // set them here too so even a proxied/short-circuited response is
      // self-describing.
      for (const [key, value] of Object.entries(rateLimitHeaders(result))) {
        c.header(key, value);
      }
      throw AppError.rateLimited(
        result.retryAfter,
        'Too many requests. Please wait a moment and try again.',
      );
    }

    await next();

    for (const [key, value] of Object.entries(rateLimitHeaders(result))) {
      c.header(key, value);
    }
  };
};

/**
 * Default read tier: looser for signed-in members, tighter for anonymous
 * visitors (who are far more likely to be a scraper).
 */
export const readLimit = (): MiddlewareHandler<AppContext> => {
  return async (c, next) => {
    const tier = c.get('user') ? RATE_TIERS.authedRead : RATE_TIERS.publicRead;
    const result = await consume(c.env.KV, tier, c.get('clientKey'));
    if (!result.allowed) {
      for (const [key, value] of Object.entries(rateLimitHeaders(result))) {
        c.header(key, value);
      }
      throw AppError.rateLimited(result.retryAfter, 'Too many requests. Please slow down.');
    }
    await next();
  };
};
