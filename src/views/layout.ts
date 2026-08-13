/**
 * The HTML document shell.
 *
 * Everything the browser receives is assembled here: `<head>` metadata (SEO,
 * OpenGraph, Twitter Card, canonical), the accessible page chrome (skip link,
 * landmarks, navigation) and the single nonce'd script tag that boots the
 * progressive-enhancement bundle.
 *
 * Rendering is server-side string building with the escaping `html` tagged
 * template — no client framework, no hydration cost, and no path by which raw
 * user input reaches the document unescaped.
 */

import { escapeHtml, html, jsonForScript, raw, type RawHtml } from '../utils/html';
import type { AuthUser } from '../types/models';
import { avatarUrl, initials } from './components/avatar';

export interface PageMeta {
  title: string;
  description?: string;
  /** Absolute canonical URL. */
  canonical?: string;
  /** Absolute image URL for OpenGraph/Twitter. */
  image?: string;
  /** `article` for posts, `profile` for users, otherwise `website`. */
  ogType?: 'website' | 'article' | 'profile';
  noindex?: boolean;
  /** JSON-LD objects injected as application/ld+json. */
  jsonLd?: unknown[];
  publishedTime?: number;
  authorName?: string;
}

export interface LayoutInput {
  meta: PageMeta;
  siteName: string;
  siteDescription: string;
  origin: string;
  nonce: string;
  csrfToken: string | null;
  user: AuthUser | null;
  unreadCount?: number;
  theme: 'light' | 'dark' | 'system';
  /** Highlighted primary-nav item. */
  active?: string;
  /** Already-escaped markup for the main column. */
  body: string;
  /** Optional already-escaped markup for the right rail. */
  aside?: string;
  /** Bootstrap data serialised into `window.__ANK__`. */
  bootstrap?: Record<string, unknown>;
}

interface NavItem {
  key: string;
  href: string;
  label: string;
  icon: string;
  /** Only shown to signed-in users. */
  auth?: boolean;
}

const NAV: readonly NavItem[] = [
  { key: 'home', href: '/', label: 'Home', icon: 'home' },
  { key: 'explore', href: '/explore', label: 'Explore', icon: 'compass' },
  { key: 'trending', href: '/trending', label: 'Trending', icon: 'flame' },
  { key: 'following', href: '/following', label: 'Following', icon: 'users', auth: true },
  { key: 'bookmarks', href: '/bookmarks', label: 'Bookmarks', icon: 'bookmark', auth: true },
];

/** Inline SVG sprite: no icon-font request, no external asset, no CSP hole. */
const ICONS: Record<string, string> = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  flame: '<path d="M12 3s5 4.5 5 9a5 5 0 0 1-10 0c0-1.5.6-2.8 1.3-3.8.4 1 1.2 1.8 2.2 1.8 0-3 1.5-5 1.5-7z"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5.5a3.2 3.2 0 0 1 0 6"/><path d="M17.5 14.5A6 6 0 0 1 21 20"/>',
  bookmark: '<path d="M6 3.5h12v17l-6-4-6 4z"/>',
  bell: '<path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9z"/><path d="M10 18a2 2 0 0 0 4 0"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M4.5 12a7.5 7.5 0 0 1 .1-1.2l-1.8-1.4 1.9-3.3 2.1.8a7.6 7.6 0 0 1 2-1.2l.3-2.2h3.8l.3 2.2c.7.3 1.4.7 2 1.2l2.1-.8 1.9 3.3-1.8 1.4a7.5 7.5 0 0 1 0 2.4l1.8 1.4-1.9 3.3-2.1-.8c-.6.5-1.3.9-2 1.2l-.3 2.2h-3.8l-.3-2.2a7.6 7.6 0 0 1-2-1.2l-2.1.8-1.9-3.3 1.8-1.4A7.5 7.5 0 0 1 4.5 12z"/>',
  shield: '<path d="M12 3 5 6v6c0 4.2 2.9 7.7 7 9 4.1-1.3 7-4.8 7-9V6z"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
};

export function icon(name: string, className = 'ico'): RawHtml {
  const path = ICONS[name] ?? '';
  return raw(
    `<svg class="${escapeHtml(className)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${path}</svg>`,
  );
}

export function renderLayout(input: LayoutInput): string {
  const { meta, user } = input;
  const title = meta.title ? `${meta.title} · ${input.siteName}` : input.siteName;
  const description = meta.description || input.siteDescription;
  const canonical = meta.canonical ?? input.origin;
  const image = meta.image ?? `${input.origin}/og-default.svg`;
  const themeClass = input.theme === 'system' ? '' : input.theme;

  const jsonLd = (meta.jsonLd ?? []).map(
    (entry) =>
      raw(
        `<script type="application/ld+json" nonce="${escapeHtml(input.nonce)}">${jsonForScript(entry)}</script>`,
      ),
  );

  return `<!doctype html>${html`
<html lang="en" class="${themeClass}" data-theme="${input.theme}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${title}</title>
  <meta name="description" content="${description}">
  <link rel="canonical" href="${canonical}">
  ${meta.noindex ? raw('<meta name="robots" content="noindex,nofollow">') : raw('<meta name="robots" content="index,follow,max-image-preview:large">')}

  <meta property="og:site_name" content="${input.siteName}">
  <meta property="og:type" content="${meta.ogType ?? 'website'}">
  <meta property="og:title" content="${meta.title || input.siteName}">
  <meta property="og:description" content="${description}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${image}">
  ${meta.publishedTime
    ? raw(
        `<meta property="article:published_time" content="${escapeHtml(new Date(meta.publishedTime * 1000).toISOString())}">`,
      )
    : ''}
  ${meta.authorName ? raw(`<meta property="article:author" content="${escapeHtml(meta.authorName)}">`) : ''}

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${meta.title || input.siteName}">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:image" content="${image}">

  <meta name="theme-color" content="#0b0f19" media="(prefers-color-scheme: dark)">
  <meta name="theme-color" content="#f8fafc" media="(prefers-color-scheme: light)">
  <meta name="csrf-token" content="${input.csrfToken ?? ''}">

  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/icon-180.png">
  <link rel="manifest" href="/site.webmanifest">
  <link rel="alternate" type="application/rss+xml" title="${input.siteName} — latest posts" href="/feed.xml">
  <link rel="stylesheet" href="/assets/app.css">
  ${jsonLd}
  <script nonce="${input.nonce}">${raw(THEME_BOOT)}</script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to main content</a>

  <header class="topbar" role="banner">
    <div class="topbar__inner">
      <a class="brand" href="/" aria-label="${input.siteName} home">
        <span class="brand__mark" aria-hidden="true">◆</span>
        <span class="brand__text">${input.siteName}</span>
      </a>

      <form class="topsearch" role="search" action="/search" method="get">
        <label class="sr-only" for="q">Search ${input.siteName}</label>
        ${icon('search', 'ico topsearch__ico')}
        <input id="q" name="q" type="search" placeholder="Search posts, people, tags" autocomplete="off"
               maxlength="100" enterkeyhint="search">
      </form>

      <nav class="topnav" aria-label="Account">
        ${user
          ? raw(html`
            <a class="topnav__link" href="/notifications" aria-label="Notifications${input.unreadCount ? ` (${input.unreadCount} unread)` : ''}">
              ${icon('bell')}
              ${input.unreadCount
                ? raw(html`<span class="badge-count" data-unread-badge>${input.unreadCount > 99 ? '99+' : input.unreadCount}</span>`)
                : raw('<span class="badge-count is-hidden" data-unread-badge hidden></span>')}
            </a>
            <a class="topnav__link" href="/settings" aria-label="Settings">${icon('settings')}</a>
            <a class="avatar avatar--sm topnav__avatar" href="/u/${user.username}" aria-label="Your profile">
              ${avatarChip(user)}
            </a>`)
          : raw(html`
            <a class="btn btn--ghost" href="/login">Sign in</a>
            <a class="btn btn--primary" href="/register">Join</a>`)}
        <button class="topnav__link theme-toggle" type="button" data-theme-toggle aria-label="Switch colour theme">
          <span aria-hidden="true" data-theme-icon>◐</span>
        </button>
      </nav>
    </div>
  </header>

  <div class="shell">
    <nav class="sidenav" aria-label="Primary">
      <ul class="sidenav__list">
        ${NAV.filter((item) => !item.auth || !!user).map(
          (item) =>
            raw(html`<li>
              <a class="sidenav__link ${input.active === item.key ? 'is-active' : ''}" href="${item.href}"
                 ${input.active === item.key ? raw('aria-current="page"') : ''}>
                ${icon(item.icon)}<span>${item.label}</span>
              </a>
            </li>`),
        )}
        ${user && (user.role === 'admin' || user.role === 'moderator')
          ? raw(html`<li>
              <a class="sidenav__link ${input.active === 'admin' ? 'is-active' : ''}" href="/admin">
                ${icon('shield')}<span>Moderation</span>
              </a>
            </li>`)
          : ''}
      </ul>
      ${user
        ? raw(html`<a class="btn btn--primary btn--block sidenav__cta" href="/compose">${icon('plus')} New post</a>`)
        : ''}
      <p class="sidenav__foot">
        <a href="/about">About</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a>
      </p>
    </nav>

    <main id="main" class="main" role="main" tabindex="-1">
      ${raw(input.body)}
    </main>

    ${input.aside ? raw(html`<aside class="rail" aria-label="Discover">${raw(input.aside)}</aside>`) : ''}
  </div>

  <div class="toaster" data-toaster aria-live="polite" aria-atomic="true"></div>

  <script nonce="${input.nonce}">window.__ANK__=${raw(jsonForScript({
    user: user ? { id: user.id, username: user.username, role: user.role } : null,
    csrfToken: input.csrfToken,
    origin: input.origin,
    ...(input.bootstrap ?? {}),
  }))};</script>
  <script src="/assets/app.js" nonce="${input.nonce}" defer></script>
</body>
</html>`}`;
}

/** Avatar image or initials chip for the current user. */
function avatarChip(user: AuthUser): RawHtml {
  const url = avatarUrl(user.avatarMediaId);
  if (url) {
    return raw(
      html`<img src="${url}" alt="" width="32" height="32" loading="lazy" decoding="async">`,
    );
  }
  return raw(html`<span class="avatar__fallback" aria-hidden="true">${initials(user.displayName || user.username)}</span>`);
}

/**
 * Applies the stored theme before first paint so there is no flash of the
 * wrong colour scheme. Kept tiny and nonce'd; it touches no user data.
 */
const THEME_BOOT = `(function(){try{var m=document.cookie.match(/(?:^|; )ank_theme=([^;]*)/);var t=m?decodeURIComponent(m[1]):'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;
