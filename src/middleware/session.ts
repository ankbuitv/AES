/**
 * Session resolution + CSRF token issuance.
 *
 * Reads the HttpOnly session cookie, resolves it to a user (a single indexed
 * query that also filters expired/revoked sessions and non-active accounts),
 * applies sliding expiration, and mints/rotates the CSRF token bound to the
 * resulting scope.
 *
 * This middleware never rejects a request: an invalid cookie simply means the
 * visitor is anonymous. Authorisation is the job of `requireAuth`/`requireRole`.
 */

import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types/env';
import { CSRF_COOKIE, SESSION_COOKIE, resolveSessionSecret } from '../config';
import {
  clearSessionCookie,
  csrfCookie,
  getCookie,
  isSecureRequest,
  sessionCookie,
} from '../utils/cookies';
import { ANONYMOUS_SCOPE, CSRF_TTL, issueCsrfToken, verifyCsrfToken } from '../utils/csrf';
import { toAuthUser } from '../db/repositories/users';
import { serviceContext } from '../services/context';
import { SESSION_IDLE_TTL } from '../config';

export const sessionMiddleware = (): MiddlewareHandler<AppContext> => {
  return async (c, next) => {
    const ctx = serviceContext(c);
    const secure = isSecureRequest(c.req.raw);
    const token = getCookie(c.req.raw, SESSION_COOKIE);

    let scope = ANONYMOUS_SCOPE;

    if (token) {
      const resolved = await ctx.repos.sessions.resolve(token);
      if (resolved) {
        const { session, user } = resolved;
        c.set('user', toAuthUser(user));
        c.set('sessionId', session.id);
        // Identity for the rate limiter: signed-in members are limited per
        // account, anonymous traffic per hashed IP.
        c.set('clientKey', `usr:${user.id}`);
        scope = session.id;

        // Sliding expiration, throttled inside the repository so we do not
        // write to D1 on every single request.
        ctx.defer(async () => {
          const expiresAt = await ctx.repos.sessions.touch(session);
          void expiresAt;
        });

        // Refresh the cookie so its Max-Age tracks the sliding session.
        const remaining = session.expires_at - Math.floor(Date.now() / 1000);
        c.header(
          'set-cookie',
          sessionCookie(token, remaining > 60 ? remaining : SESSION_IDLE_TTL, secure),
          { append: true },
        );
      } else {
        // Stale or forged cookie: clear it so the browser stops sending it.
        c.header('set-cookie', clearSessionCookie(secure), { append: true });
      }
    }

    // --- CSRF token ---------------------------------------------------------
    // The token is bound to the session scope. If the cookie holds a token that
    // is still valid for this scope we keep it (so parallel tabs agree);
    // otherwise we mint a fresh one and set the cookie.
    //
    // The signing secret comes from `resolveSessionSecret`: an operator-set
    // SESSION_SECRET always wins; local development falls back to a fixed
    // dev-only value so a missing `.dev.vars` cannot silently disable every
    // form/fetch mutation (uploading a photo included). Outside development a
    // missing secret degrades gracefully instead of 500-ing: anonymous
    // browsing keeps working and mutating requests fail with a clear CSRF 403.
    const existing = getCookie(c.req.raw, CSRF_COOKIE);
    const secret = resolveSessionSecret(c.env);
    let csrfToken: string | null = null;

    if (secret) {
      if (existing && (await verifyCsrfToken(secret, scope, existing))) {
        csrfToken = existing;
      } else {
        csrfToken = await issueCsrfToken(secret, scope);
        c.header('set-cookie', csrfCookie(csrfToken, CSRF_TTL, secure), { append: true });
      }
    }
    c.set('csrfToken', csrfToken);

    await next();
  };
};
