/**
 * `/search` — combined results for posts, people and hashtags.
 *
 * Results come from the `SearchProvider` abstraction, so this view only knows
 * about DTOs. The form is a GET so results are linkable and shareable.
 */

import { html, raw } from '../../utils/html';
import type { PostDTO, PublicUser } from '../../types/models';
import { LIMITS } from '../../config';
import { postCard, emptyState } from '../components/post';
import { userChip } from '../components/avatar';

export type SearchTab = 'all' | 'posts' | 'users' | 'tags';

export interface SearchTagHit {
  slug: string;
  name: string;
  postCount: number;
}

export interface SearchPageInput {
  query: string;
  tab: SearchTab;
  posts: PostDTO[];
  users: PublicUser[];
  tags: SearchTagHit[];
  nextCursor: string | null;
  hasMore: boolean;
}

const TABS: { key: SearchTab; label: string }[] = [
  { key: 'all', label: 'Top' },
  { key: 'posts', label: 'Posts' },
  { key: 'users', label: 'People' },
  { key: 'tags', label: 'Tags' },
];

function searchForm(input: SearchPageInput): string {
  return html`
    <form class="searchform" method="get" action="/search" role="search">
      <label class="sr-only" for="search-q">Search AES</label>
      <input id="search-q" class="searchform__input" type="search" name="q" value="${input.query}"
             maxlength="${LIMITS.searchQueryMax}" placeholder="Search posts, people and tags"
             autocomplete="off" spellcheck="false">
      <input type="hidden" name="type" value="${input.tab}">
      <button class="btn btn--primary" type="submit">Search</button>
    </form>
  `;
}

function tabs(input: SearchPageInput): string {
  const q = encodeURIComponent(input.query);
  return html`
    <nav class="tabs" aria-label="Search filters">
      ${TABS.map((tab) => {
        const active = tab.key === input.tab;
        return raw(html`
          <a class="tab ${active ? 'is-active' : ''}" href="/search?q=${q}&amp;type=${tab.key}"
             ${active ? raw('aria-current="page"') : ''}>${tab.label}</a>`);
      })}
    </nav>
  `;
}

function peopleSection(users: PublicUser[]): string {
  if (!users.length) return '';
  return html`
    <section class="results" aria-labelledby="results-people">
      <h2 class="results__title" id="results-people">People</h2>
      <ul class="peoplelist">
        ${users.map(
          (user) => raw(html`
            <li class="peoplelist__item">
              ${userChip(user, 'md')}
              ${user.bio ? raw(html`<p class="muted">${user.bio}</p>`) : ''}
              <a class="btn btn--small btn--ghost" href="/u/${user.username}">View profile</a>
            </li>`),
        )}
      </ul>
    </section>
  `;
}

function tagsSection(tags: SearchTagHit[]): string {
  if (!tags.length) return '';
  return html`
    <section class="results" aria-labelledby="results-tags">
      <h2 class="results__title" id="results-tags">Hashtags</h2>
      <ul class="taglist">
        ${tags.map(
          (tag) => raw(html`
            <li>
              <a class="tagchip" href="/tag/${tag.slug}">
                <span>#${tag.name}</span>
                <span class="muted">${tag.postCount}</span>
              </a>
            </li>`),
        )}
      </ul>
    </section>
  `;
}

function postsSection(input: SearchPageInput): string {
  if (!input.posts.length) return '';
  const endpoint = `/api/search?q=${encodeURIComponent(input.query)}&type=${input.tab}`;
  return html`
    <section class="results" aria-labelledby="results-posts">
      <h2 class="results__title" id="results-posts">Posts</h2>
      <div class="feed" data-feed data-endpoint="${endpoint}">
        ${input.posts.map((post) => raw(postCard(post)))}
      </div>
      ${input.hasMore && input.nextCursor
        ? raw(html`
            <div class="loadmore">
              <button class="btn btn--ghost btn--block" type="button" data-load-more
                      data-cursor="${input.nextCursor}">Load more results</button>
            </div>`)
        : ''}
    </section>
  `;
}

export function renderSearchPage(input: SearchPageInput): string {
  const nothing = !input.posts.length && !input.users.length && !input.tags.length;

  return html`
    <div class="pagehead">
      <h1 class="pagehead__title">Search</h1>
      ${input.query
        ? raw(html`<p class="pagehead__sub muted">Results for “${input.query}”</p>`)
        : raw(html`<p class="pagehead__sub muted">Find posts, people and hashtags.</p>`)}
    </div>

    ${raw(searchForm(input))}
    ${input.query ? raw(tabs(input)) : ''}

    ${!input.query
      ? raw(
          emptyState(
            'Start typing',
            'Search matches post titles, post bodies, usernames, display names and hashtags.',
            { href: '/trending', label: 'Browse trending instead' },
          ),
        )
      : nothing
        ? raw(
            emptyState(
              'No matches',
              'Nothing matched that query. Try fewer words, or a different spelling.',
              { href: '/explore', label: 'Browse the latest posts' },
            ),
          )
        : raw(html`
            ${input.tab === 'all' || input.tab === 'users' ? raw(peopleSection(input.users)) : ''}
            ${input.tab === 'all' || input.tab === 'tags' ? raw(tagsSection(input.tags)) : ''}
            ${input.tab === 'all' || input.tab === 'posts' ? raw(postsSection(input)) : ''}
          `)}
  `;
}
