/**
 * Bridge between a request context and the HTML layout.
 *
 * Route handlers describe *what* the page is (meta, body, rail) and this
 * module supplies everything that comes from the request: the signed-in user,
 * the CSRF token, the CSP nonce, the theme cookie and the unread badge count.
 * Doing it in one place is what stops a page from accidentally rendering
 * without a nonce or leaking another user's state.
 */

import type { Context } from 'hono';
import type { AppContext } from '../types/env';
import { getConfig, resolveOrigin } from '../config';
import { readTheme } from '../utils/cookies';
import { renderLayout, type PageMeta } from './layout';
import { serviceContext } from '../services/context';
import { NotificationService } from '../services/notifications';

export interface PageOptions {
  meta: PageMeta;
  body: string;
  aside?: string;
  active?: string;
  bootstrap?: Record<string, unknown>;
  /** Status pages use a focused, full-width shell without the social rails. */
  layout?: 'app' | 'status';
  status?: number;
  /** Seconds of shared-cache TTL. Only ever set for anonymous, public pages. */
  cacheSeconds?: number;
}

/** Absolute URL for canonical/OG tags. */
export function absoluteUrl(c: Context<AppContext>, path: string): string {
  const origin = resolveOrigin(c.env, c.req.raw);
  return path.startsWith('http') ? path : `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

export async function renderPage(c: Context<AppContext>, options: PageOptions): Promise<Response> {
  const config = getConfig(c.env);
  const user = c.get('user') ?? null;

  // The badge is per-user state, so it is fetched only when signed in — and it
  // is exactly why authenticated pages are never shared-cached.
  let unreadCount = 0;
  if (user) {
    try {
      unreadCount = await new NotificationService(serviceContext(c)).unreadCount(user.id);
    } catch {
      unreadCount = 0;
    }
  }

  const html = renderLayout({
    meta: options.meta,
    siteName: config.siteName,
    siteDescription: config.siteDescription,
    origin: resolveOrigin(c.env, c.req.raw),
    nonce: c.get('cspNonce') ?? '',
    csrfToken: c.get('csrfToken') ?? null,
    user,
    unreadCount,
    theme: readTheme(c.req.raw),
    ...(options.active ? { active: options.active } : {}),
    body: options.body,
    ...(options.aside ? { aside: options.aside } : {}),
    ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
    ...(options.layout ? { variant: options.layout } : {}),
  });

  // Private pages must never land in a shared cache. Anonymous public pages
  // may be cached briefly at the edge, but still revalidate.
  if (user || !options.cacheSeconds) {
    c.header('cache-control', 'private, no-store');
  } else {
    c.header('cache-control', `public, max-age=0, s-maxage=${options.cacheSeconds}, must-revalidate`);
    c.header('vary', 'Cookie, Accept-Encoding');
  }

  return c.html(html, (options.status ?? 200) as 200);
}
