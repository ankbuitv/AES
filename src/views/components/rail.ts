/**
 * Right-rail widgets (trending tags, who to follow, level leaderboard).
 *
 * Every widget degrades to nothing when its data is empty, so a brand-new
 * install renders a clean page instead of empty boxes.
 */

import { html, raw } from '../../utils/html';
import type { PublicUser } from '../../types/models';
import { avatar } from './avatar';

export interface RailTag {
  slug: string;
  name: string;
  postCount: number;
}

export function trendingTagsWidget(tags: RailTag[]): string {
  if (!tags.length) return '';
  return html`
    <section class="widget" aria-labelledby="widget-tags">
      <h2 class="widget__title" id="widget-tags">Trending tags</h2>
      <ul class="widget__list">
        ${tags.map(
          (tag) => raw(html`
            <li>
              <a class="widget__row" href="/tag/${tag.slug}">
                <span class="tag">#${tag.name}</span>
                <span class="muted">${tag.postCount} ${tag.postCount === 1 ? 'post' : 'posts'}</span>
              </a>
            </li>`),
        )}
      </ul>
    </section>
  `;
}

export function suggestedUsersWidget(users: PublicUser[], csrfToken: string | null): string {
  if (!users.length) return '';
  return html`
    <section class="widget" aria-labelledby="widget-people">
      <h2 class="widget__title" id="widget-people">Who to follow</h2>
      <ul class="widget__list">
        ${users.map(
          (user) => raw(html`
            <li class="widget__person">
              ${avatar(user, 'sm')}
              <div class="widget__person-meta">
                <a class="widget__person-name" href="/u/${user.username}">${user.displayName || user.username}</a>
                <span class="muted">@${user.username} · Lv ${user.level}</span>
              </div>
              ${csrfToken
                ? raw(html`
                    <form method="post" action="/api/users/${user.username}/follow" data-follow-form>
                      <input type="hidden" name="_csrf" value="${csrfToken}">
                      <button class="btn btn--small" type="submit" data-follow data-username="${user.username}"
                              aria-pressed="false">Follow</button>
                    </form>`)
                : raw(html`<a class="btn btn--small" href="/login">Follow</a>`)}
            </li>`),
        )}
      </ul>
    </section>
  `;
}

export interface LeaderRow {
  username: string;
  display_name: string;
  level: number;
  xp: number;
  avatar_media_id: string | null;
  id: string;
}

export function leaderboardWidget(rows: LeaderRow[]): string {
  if (!rows.length) return '';
  return html`
    <section class="widget" aria-labelledby="widget-leaders">
      <h2 class="widget__title" id="widget-leaders">Top contributors</h2>
      <ol class="widget__list widget__list--ranked">
        ${rows.map(
          (row, index) => raw(html`
            <li class="widget__row">
              <span class="rank" aria-hidden="true">${index + 1}</span>
              <a href="/u/${row.username}">${row.display_name || row.username}</a>
              <span class="muted">Lv ${row.level}</span>
            </li>`),
        )}
      </ol>
    </section>
  `;
}

export function aboutWidget(siteName: string, description: string): string {
  return html`
    <section class="widget widget--about">
      <h2 class="widget__title">About ${siteName}</h2>
      <p class="muted">${description}</p>
      <p class="widget__links">
        <a href="/explore">Explore</a> · <a href="/trending">Trending</a> · <a href="/feed.xml">RSS</a>
      </p>
    </section>
  `;
}
