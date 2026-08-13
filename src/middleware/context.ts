/**
 * Request context middleware.
 *
 * Runs first on every request and establishes the values the rest of the
 * stack depends on: a request id, a start timestamp, a CSP nonce, the client
 * IP and a stable rate-limit key. It also emits exactly one structured access
 * log line per request (method, route, status, duration, request id) with no
 * credential material in it.
 */

import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types/env';
import { getConfig } from '../config';
import { createLogger } from '../utils/logger';
import { privacyHash } from '../utils/crypto';
import { randomToken } from '../utils/id';

/** Cloudflare always sets CF-Connecting-IP; the others are dev fallbacks. */
export function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-real-ip') ??
    (request.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() ??
    '0.0.0.0'
  );
}

export const requestContext = (): MiddlewareHandler<AppContext> => {
  return async (c, next) => {
    const start = Date.now();
    // Honour Cloudflare's ray id when present so logs correlate with the edge.
    const requestId =
      c.req.header('cf-ray') ?? c.req.header('x-request-id')?.slice(0, 64) ?? randomToken(12);

    const ip = clientIp(c.req.raw);
    const config = getConfig(c.env);
    const logger = createLogger(config.logLevel, { requestId });

    c.set('requestId', requestId);
    c.set('startTime', start);
    c.set('user', null);
    c.set('sessionId', null);
    c.set('csrfToken', null);
    c.set('clientIp', ip);
    c.set('cspNonce', randomToken(16));

    // The rate-limit key must not be a raw IP: it is hashed with a salt so
    // logs and KV keys never contain personal data.
    const salt = c.env.IP_HASH_SALT || c.env.SESSION_SECRET || 'dev-salt';
    c.set('clientKey', `ip:${(await privacyHash(ip, salt)).slice(0, 32)}`);

    await next();

    const duration = Date.now() - start;
    c.header('x-request-id', requestId);
    // Server-Timing makes the duration visible in browser devtools.
    c.header('server-timing', `app;dur=${duration}`);

    const status = c.res.status;
    const fields = {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      route: c.req.routePath,
      status,
      duration,
      userId: c.get('user')?.id ?? null,
      errorCode: c.res.headers.get('x-error-code'),
    };
    if (status >= 500) logger.error('request', fields);
    else if (status >= 400) logger.warn('request', fields);
    else logger.info('request', fields);
  };
};
