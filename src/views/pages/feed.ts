/**
 * Feed pages: Home (For you), Explore (Latest), Trending, Following,
 * Bookmarks, plus tag and category listings.
 *
 * All of them render the same `feedList` component with a different heading
 * and endpoint, so the client-side "load more" behaviour is identical
 * everywhere and the no-JS fallback link always works.
 */

import { html, raw } from '../../utils/html';
import type { Page, PostDTO } from '../../types/models';
import { feedList, feedTabs, type FeedTab } from '../components/feed';

export interface FeedPageInput {
  heading: string;
  subheading?: string;
  page: Page<PostDTO>;
  baseHref: string;
  loadMoreEndpoint: string;
  activeTab: string;
  showTabs?: boolean;
  signedIn: boolean;
  emptyTitle?: string;
  emptyBody?: string;
  emptyCta?: { href: string; label: string };
  /** Optional composer shown at the top for signed-in members. */
  composer?: string;
}

export function feedTabsFor(signedIn: boolean): FeedTab[] {
  const tabs: FeedTab[] = [
    { key: 'latest', href: '/', label: 'Latest' },
    { key: 'trending', href: '/trending', label: 'Trending' },
    { key: 'foryou', href: '/explore', label: 'For you' },
  ];
  if (signedIn) tabs.push({ key: 'following', href: '/following', label: 'Following' });
  return tabs;
}

export function renderFeedPage(input: FeedPageInput): string {
  return html`
    <div class="pagehead">
      <h1 class="pagehead__title">${input.heading}</h1>
      ${input.subheading ? raw(html`<p class="pagehead__sub muted">${input.subheading}</p>`) : ''}
    </div>

    ${input.showTabs === false ? '' : raw(feedTabs(feedTabsFor(input.signedIn), input.activeTab))}
    ${input.composer ? raw(input.composer) : ''}
    ${raw(
      feedList({
        page: input.page,
        baseHref: input.baseHref,
        loadMoreEndpoint: input.loadMoreEndpoint,
        ...(input.emptyTitle ? { emptyTitle: input.emptyTitle } : {}),
        ...(input.emptyBody ? { emptyBody: input.emptyBody } : {}),
        ...(input.emptyCta ? { emptyCta: input.emptyCta } : {}),
      }),
    )}
  `;
}

/**
 * Inline composer. It is a real `<form>` posting to the API, so it works
 * without JavaScript; the client upgrades it to fetch + optimistic prepend.
 */
export function composer(csrfToken: string | null, categories: { slug: string; name: string }[]): string {
  if (!csrfToken) return '';
  return html`
    <form class="composer" method="post" action="/api/posts" data-composer enctype="multipart/form-data">
      <input type="hidden" name="_csrf" value="${csrfToken}">
      <input type="hidden" name="contentType" value="markdown">
      <label class="sr-only" for="composer-content">What's on your mind?</label>
      <textarea id="composer-content" name="content" rows="3" required maxlength="40000"
                placeholder="Share something with the community…" data-composer-content></textarea>

      <!--
        Everything optional lives behind a <details> disclosure. It is plain
        HTML, so it opens without JavaScript, and the browser keeps the fields
        in the form whether or not the panel is expanded — nothing is lost on
        submit.
      -->
      <details class="composer__more">
        <summary class="composer__more-summary">
          <span class="composer__more-label">More options</span>
          <span class="composer__more-hint muted">Title, tags, category, visibility, schedule, poll</span>
        </summary>

        <div class="composer__more-body">
          <div class="composer__row">
            <label class="sr-only" for="composer-title">Title (optional)</label>
            <input id="composer-title" name="title" type="text" maxlength="160" placeholder="Title (optional)">

            <label class="sr-only" for="composer-tags">Tags</label>
            <input id="composer-tags" name="tags" type="text" maxlength="200" placeholder="tags, comma, separated">
          </div>

          <div class="composer__row">
            <label class="sr-only" for="composer-category">Category</label>
            <select id="composer-category" name="category">
              <option value="">No category</option>
              ${categories.map((cat) => raw(html`<option value="${cat.slug}">${cat.name}</option>`))}
            </select>

            <label class="sr-only" for="composer-visibility">Visibility</label>
            <select id="composer-visibility" name="visibility">
              <option value="public">Public</option>
              <option value="followers">Followers</option>
              <option value="private">Only me</option>
            </select>

            <label class="sr-only" for="composer-schedule">Schedule</label>
            <input id="composer-schedule" name="scheduledAt" type="datetime-local">
          </div>

          <div class="field">
            <label for="composer-poll">Poll options <span class="muted">(one per line)</span></label>
            <textarea id="composer-poll" name="pollOptions" rows="3" maxlength="400" placeholder="Option A&#10;Option B"></textarea>
          </div>
        </div>
      </details>

      <div class="composer__foot">
        <label class="filebtn">
          <input type="file" name="image" accept="image/png,image/jpeg,image/webp,image/gif" data-composer-file>
          <span>Add image</span>
        </label>
        <button class="btn btn--primary" type="submit">Post</button>
      </div>
      <p class="composer__hint muted">Markdown supported. Images are uploaded to your library first, then attached.</p>
    </form>
  `;
}
