/**
 * Feed list + cursor "load more".
 *
 * The list is fully server-rendered (so it works, and is indexable, with
 * JavaScript disabled) and the client enhances the button into an in-place
 * append. The fallback is a real link to `?cursor=…`, never a dead button.
 */

import { html, raw } from '../../utils/html';
import type { Page, PostDTO } from '../../types/models';
import { emptyState, postCard } from './post';

export interface FeedTab {
  key: string;
  href: string;
  label: string;
}

export function feedTabs(tabs: FeedTab[], active: string): string {
  return html`
    <nav class="tabs" aria-label="Feed">
      ${tabs.map(
        (tab) => raw(html`
          <a class="tab ${tab.key === active ? 'is-active' : ''}" href="${tab.href}"
             ${tab.key === active ? raw('aria-current="page"') : ''}>${tab.label}</a>`),
      )}
    </nav>
  `;
}

export interface FeedListInput {
  page: Page<PostDTO>;
  /** Base path used to build the no-JS "next page" link. */
  baseHref: string;
  emptyTitle?: string;
  emptyBody?: string;
  emptyCta?: { href: string; label: string };
  /** API endpoint the client calls to append the next page. */
  loadMoreEndpoint: string;
}

export function feedList(input: FeedListInput): string {
  if (!input.page.items.length) {
    return emptyState(
      input.emptyTitle ?? 'Nothing here yet',
      input.emptyBody ?? 'When there are posts to show, they will appear right here.',
      input.emptyCta,
    );
  }

  const separator = input.baseHref.includes('?') ? '&' : '?';

  return html`
    <div class="feed" data-feed data-endpoint="${input.loadMoreEndpoint}">
      ${input.page.items.map((post) => raw(postCard(post)))}
    </div>
    ${input.page.nextCursor
      ? raw(html`
          <div class="feed__more">
            <a class="btn btn--ghost btn--block" data-load-more data-cursor="${input.page.nextCursor}"
               href="${input.baseHref}${separator}cursor=${encodeURIComponent(input.page.nextCursor)}">
              Load more
            </a>
          </div>`)
      : raw(html`<p class="feed__end muted">You have reached the end.</p>`)}
  `;
}
