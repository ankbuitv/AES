/**
 * Profile pages: `/u/{username}`, `/u/{username}/media`, `/u/{username}/replies`.
 *
 * The header is shared by all three tabs; the body swaps between a post feed,
 * a media grid and a list of comment replies.
 */

import { html, raw } from '../../utils/html';
import type { CommentDTO, Page, PostDTO } from '../../types/models';
import type { ProfileView } from '../../services/users';
import { feedList } from '../components/feed';
import { avatar } from '../components/avatar';
import { emptyState } from '../components/post';
import { relativeTime, toIso } from '../../utils/time';
import { avatarUrl } from '../components/avatar';

export type ProfileTab = 'posts' | 'media' | 'replies';

export interface ProfilePageInput {
  profile: ProfileView;
  tab: ProfileTab;
  csrfToken: string | null;
  signedIn: boolean;
  posts?: Page<PostDTO>;
  replies?: Page<CommentDTO>;
}

function header(profile: ProfileView, csrfToken: string | null, signedIn: boolean): string {
  const cover = avatarUrl(profile.coverMediaId, 'original');
  const progress = profile.levelProgress;

  return html`
    <header class="profile" data-profile data-username="${profile.username}">
      <div class="profile__cover" ${cover ? raw(`style="background-image:url('${cover}')"`) : ''} aria-hidden="true"></div>

      <div class="profile__head">
        ${avatar(profile, 'xl', false)}
        <div class="profile__identity">
          <h1 class="profile__name">${profile.displayName || profile.username}</h1>
          <p class="profile__handle">
            @${profile.username}
            <span class="pill pill--level">Level ${profile.level}</span>
            ${profile.role === 'admin' || profile.role === 'moderator'
              ? raw(html`<span class="pill pill--staff">${profile.role === 'admin' ? 'Admin' : 'Moderator'}</span>`)
              : ''}
            ${profile.isFollowedBy ? raw(html`<span class="pill pill--muted">Follows you</span>`) : ''}
          </p>
        </div>

        <div class="profile__actions">
          ${profile.isSelf
            ? raw(html`<a class="btn btn--ghost" href="/settings">Edit profile</a>`)
            : signedIn && csrfToken
              ? raw(html`
                  <form method="post" action="/api/users/${profile.username}/${profile.isFollowing ? 'unfollow' : 'follow'}" data-follow-form>
                    <input type="hidden" name="_csrf" value="${csrfToken}">
                    <button class="btn ${profile.isFollowing ? 'btn--ghost' : 'btn--primary'}" type="submit"
                            data-follow data-username="${profile.username}"
                            aria-pressed="${profile.isFollowing ? 'true' : 'false'}">
                      ${profile.isFollowing ? 'Following' : 'Follow'}
                    </button>
                  </form>
                  <button class="btn btn--ghost" type="button" data-report data-target-type="user" data-target-id="${profile.id}">Report</button>`)
              : raw(html`<a class="btn btn--primary" href="/login">Sign in to follow</a>`)}
        </div>
      </div>

      ${profile.bio ? raw(html`<p class="profile__bio">${profile.bio}</p>`) : ''}

      <ul class="profile__facts">
        ${profile.location ? raw(html`<li>📍 ${profile.location}</li>`) : ''}
        ${profile.website
          ? raw(html`<li>🔗 <a href="${profile.website}" rel="nofollow noopener ugc" target="_blank">${profile.website}</a></li>`)
          : ''}
        <li>🗓 Joined <time datetime="${toIso(profile.createdAt)}">${relativeTime(profile.createdAt)}</time></li>
      </ul>

      <dl class="statgrid statgrid--profile">
        <div><dt>Posts</dt><dd>${profile.postCount}</dd></div>
        <div><dt>Comments</dt><dd>${profile.commentCount}</dd></div>
        <div><dt>Followers</dt><dd><a href="/u/${profile.username}/followers">${profile.followerCount}</a></dd></div>
        <div><dt>Following</dt><dd><a href="/u/${profile.username}/following">${profile.followingCount}</a></dd></div>
        <div><dt>Reactions</dt><dd>${profile.reactionReceivedCount}</dd></div>
      </dl>

      <div class="levelbar" role="group" aria-label="Level progress">
        <div class="levelbar__track">
          <div class="levelbar__fill" style="width:${Math.max(2, Math.min(100, progress.pct))}%"></div>
        </div>
        <p class="muted">${progress.current} / ${progress.needed} XP to level ${progress.level + 1}</p>
      </div>

      ${profile.badgeDetails.length
        ? raw(html`
            <ul class="badges" aria-label="Badges">
              ${profile.badgeDetails.map(
                (badge) => raw(html`<li class="badge" title="${badge.description}"><span aria-hidden="true">${badge.icon}</span> ${badge.name}</li>`),
              )}
            </ul>`)
        : ''}

    </header>
  `;
}

function tabs(username: string, active: ProfileTab): string {
  const items: { key: ProfileTab; href: string; label: string }[] = [
    { key: 'posts', href: `/u/${username}`, label: 'Posts' },
    { key: 'media', href: `/u/${username}/media`, label: 'Media' },
    { key: 'replies', href: `/u/${username}/replies`, label: 'Replies' },
  ];
  return html`
    <nav class="tabs" aria-label="Profile sections">
      ${items.map(
        (item) => raw(html`
          <a class="tab ${item.key === active ? 'is-active' : ''}" href="${item.href}"
             ${item.key === active ? raw('aria-current="page"') : ''}>${item.label}</a>`),
      )}
    </nav>
  `;
}

function repliesList(username: string, page: Page<CommentDTO>): string {
  if (!page.items.length) {
    return emptyState('No replies yet', `@${username} has not commented on anything yet.`);
  }
  return html`
    <ul class="replies" data-feed data-endpoint="/api/users/${username}/replies">
      ${page.items.map(
        (comment) => raw(html`
          <li class="reply">
            <a class="reply__context muted" href="/post/${comment.postSlug}#comment-${comment.id}">
              View the conversation
            </a>
            <div class="prose prose--sm">${raw(comment.html)}</div>
            <time class="muted" datetime="${toIso(comment.createdAt)}">${relativeTime(comment.createdAt)}</time>
          </li>`),
      )}
    </ul>
    ${page.nextCursor
      ? raw(html`<a class="btn btn--ghost btn--block" data-load-more data-cursor="${page.nextCursor}"
             href="/u/${username}/replies?cursor=${encodeURIComponent(page.nextCursor)}">Load more</a>`)
      : ''}
  `;
}

export function renderProfilePage(input: ProfilePageInput): string {
  const { profile } = input;

  let body: string;
  if (input.tab === 'replies') {
    body = repliesList(profile.username, input.replies ?? { items: [], nextCursor: null, hasMore: false });
  } else {
    const page = input.posts ?? { items: [], nextCursor: null, hasMore: false };
    const base = input.tab === 'media' ? `/u/${profile.username}/media` : `/u/${profile.username}`;
    const endpoint =
      input.tab === 'media'
        ? `/api/users/${profile.username}/posts?media=1`
        : `/api/users/${profile.username}/posts`;

    body = feedList({
      page,
      baseHref: base,
      loadMoreEndpoint: endpoint,
      emptyTitle: input.tab === 'media' ? 'No media yet' : 'No posts yet',
      emptyBody:
        input.tab === 'media'
          ? `@${profile.username} has not shared any images yet.`
          : profile.isSelf
            ? 'Your posts will appear here. Share your first one.'
            : `@${profile.username} has not posted anything yet.`,
      ...(profile.isSelf ? { emptyCta: { href: '/compose', label: 'Write a post' } } : {}),
    });
  }

  return html`
    ${raw(header(profile, input.csrfToken, input.signedIn))}
    ${raw(tabs(profile.username, input.tab))}
    ${raw(body)}
  `;
}

/** `/u/{username}/followers` and `/following`. */
export function renderPeoplePage(input: {
  title: string;
  username: string;
  people: { id: string; username: string; displayName: string; avatarMediaId: string | null; level: number; bio: string }[];
  nextCursor: string | null;
  baseHref: string;
}): string {
  return html`
    <div class="pagehead">
      <h1 class="pagehead__title">${input.title}</h1>
      <p class="pagehead__sub muted"><a href="/u/${input.username}">← Back to @${input.username}</a></p>
    </div>

    ${input.people.length
      ? raw(html`
          <ul class="peoplelist">
            ${input.people.map(
              (person) => raw(html`
                <li class="peoplelist__item">
                  ${avatar(person, 'md')}
                  <div>
                    <a class="peoplelist__name" href="/u/${person.username}">${person.displayName || person.username}</a>
                    <p class="muted">@${person.username} · Lv ${person.level}</p>
                    ${person.bio ? raw(html`<p class="muted">${person.bio}</p>`) : ''}
                  </div>
                </li>`),
            )}
          </ul>`)
      : raw(emptyState('Nobody here yet', 'This list is empty for now.'))}

    ${input.nextCursor
      ? raw(html`<a class="btn btn--ghost btn--block" href="${input.baseHref}?cursor=${encodeURIComponent(input.nextCursor)}">Load more</a>`)
      : ''}
  `;
}
