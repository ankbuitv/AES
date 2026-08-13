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

function kind(status: number): 'error' | 'offline' | 'auth' | 'empty' {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'empty';
  return 'error';
}

export function renderErrorPage(input: ErrorPageInput): string {
  const publicMessage =
    input.status >= 500
      ? 'Something went wrong. Please try again in a moment.'
      : input.message;

  const body = html`
    <section class="errorpage" data-state="${kind(input.status)}" role="alert" aria-labelledby="error-title">
      <p class="errorpage__status" aria-hidden="true">${input.status}</p>
      <h1 class="errorpage__title" id="error-title">${input.title}</h1>
      <p class="errorpage__message">${publicMessage}</p>
      ${input.retryAfter
        ? raw(html`<p class="errorpage__hint">Try again in about ${input.retryAfter} second${input.retryAfter === 1 ? '' : 's'}.</p>`)
        : ''}
      <div class="errorpage__actions">
        ${input.status >= 500
          ? raw(html`<a class="btn btn--primary" href="" data-retry>Retry</a>`)
          : ''}
        ${input.loginHref
          ? raw(html`<a class="btn btn--primary" href="${input.loginHref}">Sign in</a>`)
          : ''}
        <a class="btn ${input.status >= 500 || input.loginHref ? 'btn--ghost' : 'btn--primary'}" href="/">Back to home</a>
        <a class="btn btn--ghost" href="/status">Service status</a>
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
      description: publicMessage,
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

/** Shared empty / offline / unauthorized cards used by feed and pages. */
export function renderStateCard(input: {
  kind: 'empty' | 'error' | 'offline' | 'loading';
  title: string;
  body: string;
  action?: { href: string; label: string };
}): string {
  return html`
    <div class="empty empty--${input.kind}" data-state="${input.kind}" ${input.kind === 'error' ? raw('role="alert"') : ''}>
      <p class="empty__title">${input.title}</p>
      <p class="empty__body">${input.body}</p>
      ${input.action ? raw(html`<a class="btn btn--primary" href="${input.action.href}">${input.action.label}</a>`) : ''}
    </div>
  `;
}

export function feedSkeleton(count = 3): string {
  return html`
    <div class="feed" aria-busy="true" aria-label="Loading posts">
      ${Array.from({ length: count }, () =>
        raw(`<article class="postcard postcard--skeleton" aria-hidden="true">
          <div class="postcard__head">
            <span class="sk sk--avatar"></span>
            <div class="postcard__meta" style="flex:1">
              <span class="sk sk--line" style="width:40%"></span>
              <span class="sk sk--line" style="width:24%"></span>
            </div>
          </div>
          <span class="sk sk--line" style="width:88%"></span>
          <span class="sk sk--line" style="width:72%"></span>
          <span class="sk sk--block"></span>
        </article>`),
      )}
    </div>
  `;
}
