/**
 * Security headers.
 *
 * A single place that decides the browser-facing security posture, so no
 * route can accidentally ship a weaker policy:
 *
 *  - Content-Security-Policy with a per-request nonce. No `unsafe-inline`
 *    for scripts, so an injected `<script>` cannot execute even if escaping
 *    were bypassed somewhere.
 *  - `X-Content-Type-Options: nosniff` — browsers must honour our MIME type.
 *  - `Referrer-Policy: strict-origin-when-cross-origin` — no path leakage.
 *  - `Permissions-Policy` denies every powerful feature we do not use.
 *  - HSTS in production only (never on http://localhost).
 *  - `X-Frame-Options: DENY` + `frame-ancestors 'none'` for clickjacking.
 */

import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types/env';

/**
 * Build the CSP. `style-src` allows inline styles because the SSR layer emits
 * a handful of small inline style attributes (progress bars, avatar colours);
 * inline *styles* cannot execute script. `script-src` is nonce-only.
 */
export function contentSecurityPolicy(nonce: string, origin: string): string {
  const self = "'self'";
  return [
    `default-src ${self}`,
    `base-uri ${self}`,
    `script-src ${self} 'nonce-${nonce}'`,
    `style-src ${self} 'unsafe-inline'`,
    `img-src ${self} data: blob:`,
    `media-src ${self}`,
    `font-src ${self} data:`,
    `connect-src ${self} ${origin}`,
    `form-action ${self}`,
    `frame-ancestors 'none'`,
    `object-src 'none'`,
    `manifest-src ${self}`,
    'upgrade-insecure-requests',
  ].join('; ');
}

export const securityHeaders = (): MiddlewareHandler<AppContext> => {
  return async (c, next) => {
    await next();

    const headers = c.res.headers;
    const contentType = headers.get('content-type') ?? '';

    headers.set('x-content-type-options', 'nosniff');
    headers.set('referrer-policy', 'strict-origin-when-cross-origin');
    headers.set('x-frame-options', 'DENY');
    headers.set(
      'permissions-policy',
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()',
    );
    headers.set('cross-origin-opener-policy', 'same-origin');
    headers.set('cross-origin-resource-policy', 'same-origin');
    headers.set('x-dns-prefetch-control', 'off');

    // HTML documents get the full CSP. Media/JSON responses set their own
    // (stricter) policy where relevant, so do not clobber it.
    if (contentType.includes('text/html') && !headers.has('content-security-policy')) {
      const url = new URL(c.req.url);
      headers.set(
        'content-security-policy',
        contentSecurityPolicy(c.get('cspNonce'), `${url.protocol}//${url.host}`),
      );
    }

    if (c.env.ENVIRONMENT === 'production') {
      headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains; preload');
    }
  };
};
