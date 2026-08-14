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
import { EMBED_ORIGINS } from '../services/reelSources';

/**
 * Build the CSP. `style-src` allows inline styles because the SSR layer emits
 * a handful of small inline style attributes (progress bars, avatar colours);
 * inline *styles* cannot execute script. `script-src` is nonce-only.
 */
export function contentSecurityPolicy(nonce: string, origin: string): string {
  const self = "'self'";
  // Live chat opens a WebSocket back to this same origin. `connect-src` covers
  // WebSockets, and a `ws(s):` URL is not matched by `'self'` in every browser,
  // so the scheme twins of the origin are listed explicitly rather than
  // allowing a blanket `wss:`.
  const socketOrigins = websocketOrigins(origin);
  // Reels play inside the source platform's own iframe. `frame-src` is an
  // explicit allowlist of those players and nothing else — an injected iframe
  // pointing anywhere else is still blocked. `img-src` gains the same hosts so
  // YouTube poster frames load; both lists come from one constant in
  // `reelSources.ts` so adding a provider cannot leave the CSP behind.
  const embeds = EMBED_ORIGINS.join(' ');
  return [
    `default-src ${self}`,
    `base-uri ${self}`,
    `script-src ${self} 'nonce-${nonce}'`,
    `style-src ${self} 'unsafe-inline'`,
    `img-src ${self} data: blob: https://i.ytimg.com`,
    // blob: covers the local preview of a voice clip before it is uploaded.
    `media-src ${self} blob:`,
    `frame-src ${embeds}`,
    `font-src ${self} data:`,
    `connect-src ${self} ${origin}${socketOrigins}`,
    `form-action ${self}`,
    `frame-ancestors 'none'`,
    `object-src 'none'`,
    `manifest-src ${self}`,
    'upgrade-insecure-requests',
  ].join('; ');
}

/** `https://host` → ` wss://host`, `http://host` → ` ws://host wss://host`. */
function websocketOrigins(origin: string): string {
  try {
    const url = new URL(origin);
    if (url.protocol === 'https:') return ` wss://${url.host}`;
    if (url.protocol === 'http:') return ` ws://${url.host} wss://${url.host}`;
  } catch {
    /* an unparseable SITE_URL simply contributes nothing */
  }
  return '';
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
