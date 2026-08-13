/**
 * SSR error pages (401 / 403 / 404 / 413 / 429 / 500 …).
 *
 * Rendered inside the normal layout so a failed navigation still leaves the
 * user with working navigation instead of a dead end. The body only ever
 * contains the AppError's public message — no stack traces, no internals.
 */

import { html, raw } from '../../utils/html';
import { renderLayout } from '../layout';
import type { AuthUser } from '../../types/models';

export interface ErrorPageInput {
  status: number;
  title: string;
  message: string;
  code: string;
  requestId: string | null;
  siteName: string;
  siteDescription: string;
  origin: string;
  nonce: string;
  csrfToken: string | null;
  user: AuthUser | null;
  theme: 'light' | 'dark' | 'system';
  loginHref: string | null;
  retryAfter: number | null;
}

/** A useful next step, tailored per status. */
function suggestions(status: number): { href: string; label: string }[] {
  switch (status) {
    case 401:
      return [
        { href: '/login', label: 'Sign in' },
        { href: '/register', label: 'Create an account' },
      ];
    case 403:
      return [{ href: '/', label: 'Back to the feed' }];
    case 404:
      return [
        { href: '/', label: 'Back to the feed' },
        { href: '/explore', label: 'Explore posts' },
        { href: '/search', label: 'Search' },
      ];
    case 429:
      return [{ href: '/', label: 'Back to the feed' }];
    default:
      return [
        { href: '/', label: 'Back to the feed' },
        { href: '/health', label: 'Service status' },
      ];
  }
}

export function renderErrorPage(input: ErrorPageInput): string {
  const links = input.loginHref
    ? [{ href: input.loginHref, label: 'Sign in' }, ...suggestions(input.status).slice(1)]
    : suggestions(input.status);

  const body = html`
    <section class="errorpage" role="alert" aria-labelledby="error-title">
      <p class="errorpage__status" aria-hidden="true">${input.status}</p>
      <h1 class="errorpage__title" id="error-title">${input.title}</h1>
      <p class="errorpage__message">${input.message}</p>
      ${input.retryAfter
        ? raw(html`<p class="errorpage__hint">Try again in about ${input.retryAfter} second${input.retryAfter === 1 ? '' : 's'}.</p>`)
        : ''}
      <div class="errorpage__actions">
        ${links.map(
          (link, index) => raw(html`<a class="btn ${index === 0 ? 'btn--primary' : 'btn--ghost'}" href="${link.href}">${link.label}</a>`),
        )}
      </div>
      <p class="errorpage__meta muted">
        <span>Error code <code>${input.code}</code></span>
        ${input.requestId ? raw(html` · <span>Request <code>${input.requestId}</code></span>`) : ''}
      </p>
    </section>
  `;

  return renderLayout({
    meta: {
      title: `${input.status} — ${input.title}`,
      description: input.message,
      noindex: true,
    },
    siteName: input.siteName,
    siteDescription: input.siteDescription,
    origin: input.origin,
    nonce: input.nonce,
    csrfToken: input.csrfToken,
    user: input.user,
    theme: input.theme,
    body,
  });
}
