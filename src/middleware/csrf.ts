/**
 * CSRF enforcement middleware.
 *
 * Applies the origin + signed double-submit check from `src/utils/csrf.ts` to
 * every mutating request. The token can arrive either in the `x-csrf-token`
 * header (fetch calls) or as a `_csrf` form field (progressive-enhancement
 * form posts); the body is read through `readBody`, which memoises it so the
 * route handler still sees the same payload.
 */

import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types/env';
import { CSRF_COOKIE } from '../config';
import { getCookie } from '../utils/cookies';
import { ANONYMOUS_SCOPE, CSRF_FIELD, CSRF_HEADER, assertCsrf, requiresCsrfCheck } from '../utils/csrf';
import { readBody } from './body';
import { resolveOrigin } from '../config';

export const csrfProtection = (): MiddlewareHandler<AppContext> => {
  return async (c, next) => {
    if (!requiresCsrfCheck(c.req.method)) return next();

    const url = new URL(c.req.url);
    const allowedOrigins = [
      `${url.protocol}//${url.host}`,
      resolveOrigin(c.env, c.req.raw),
    ];

    let submitted = c.req.header(CSRF_HEADER) ?? null;
    if (!submitted) {
      const contentType = (c.req.header('content-type') ?? '').toLowerCase();
      // Only form posts carry the token in the body; do not consume a JSON
      // body here unnecessarily.
      if (
        contentType.startsWith('application/x-www-form-urlencoded') ||
        contentType.startsWith('multipart/form-data')
      ) {
        const body = await readBody(c);
        const value = body.fields[CSRF_FIELD];
        submitted = typeof value === 'string' ? value : null;
      }
    }

    await assertCsrf({
      request: c.req.raw,
      secret: c.env.SESSION_SECRET ?? '',
      scope: c.get('sessionId') ?? ANONYMOUS_SCOPE,
      allowedOrigins,
      submittedToken: submitted,
      cookieToken: getCookie(c.req.raw, CSRF_COOKIE),
    });

    await next();
  };
};
