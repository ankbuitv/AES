/**
 * Post card + full post article.
 *
 * `dto.html` is produced by the markdown renderer, which escapes first and
 * only re-emits a whitelisted tag set — so it is the one value here inserted
 * with `raw()`. Every other field goes through the escaping template.
 */

import { html, raw, type RawHtml } from '../../utils/html';
import type { PostDTO, ReactionType } from '../../types/models';
import { relativeTime, toIso } from '../../utils/time';
import { avatar } from './avatar';
import { icon } from '../layout';

const REACTIONS: { type: ReactionType; glyph: string; label: string }[] = [
  { type: 'like', glyph: '👍', label: 'Like' },
  { type: 'love', glyph: '❤️', label: 'Love' },
  { type: 'insightful', glyph: '💡', label: 'Insightful' },
  { type: 'funny', glyph: '😄', label: 'Funny' },
  { type: 'sad', glyph: '😢', label: 'Sad' },
];

function mediaGrid(post: PostDTO): RawHtml {
  if (!post.media.length) return raw('');
  const count = Math.min(post.media.length, 4);
  return raw(html`
    <div class="mediagrid mediagrid--${count}">
      ${post.media.map(
        (m) => raw(html`
          <figure class="mediagrid__item">
            <a href="${m.url}" target="_blank" rel="noopener">
              <img src="${m.thumbUrl}" alt="${m.altText || 'Attached image'}"
                   ${m.width ? raw(`width="${m.width}"`) : ''} ${m.height ? raw(`height="${m.height}"`) : ''}
                   loading="lazy" decoding="async">
            </a>
            ${m.altText ? raw(html`<figcaption class="sr-only">${m.altText}</figcaption>`) : ''}
          </figure>`),
      )}
    </div>
  `);
}

function tagList(post: PostDTO): RawHtml {
  if (!post.tags.length) return raw('');
  return raw(html`
    <ul class="taglist" aria-label="Tags">
      ${post.tags.map((t) => raw(html`<li><a class="tag" href="/tag/${t.slug}">#${t.name}</a></li>`))}
    </ul>
  `);
}

function reactionBar(post: PostDTO): RawHtml {
  return raw(html`
    <div class="reactions" data-reactions data-target-type="post" data-target-id="${post.id}">
      <div class="reactions__picker" role="group" aria-label="React to this post">
        ${REACTIONS.map(
          (r) => raw(html`
            <button class="reaction ${post.viewerReaction === r.type ? 'is-active' : ''}" type="button"
                    data-reaction="${r.type}" aria-pressed="${post.viewerReaction === r.type ? 'true' : 'false'}"
                    title="${r.label}">
              <span aria-hidden="true">${r.glyph}</span><span class="sr-only">${r.label}</span>
            </button>`),
        )}
      </div>
      <span class="reactions__count" data-reaction-count>${post.reactionCount}</span>
    </div>
  `);
}

function actionBar(post: PostDTO, permalink: string): RawHtml {
  const liked = post.viewerReaction === 'like' || !!post.viewerReaction;
  return raw(html`
    <div class="postcard__actions">
      <button class="action ${post.viewerReaction ? 'is-active' : ''}" type="button"
              data-reaction="like" data-reactions data-target-type="post" data-target-id="${post.id}"
              aria-pressed="${liked ? 'true' : 'false'}" aria-label="Like">
        ${icon('heart')} <span>Like</span>
        <span data-reaction-count>${post.reactionCount || ''}</span>
      </button>
      <a class="action" href="${permalink}#comments" aria-label="${post.commentCount} comments">
        ${icon('comment')} <span>Comment</span>
        <span data-comment-count>${post.commentCount || ''}</span>
      </a>
      <button class="action" type="button" data-share data-url="${permalink}" data-title="${post.title || 'Post'}">
        ${icon('share')} <span>Share</span>
      </button>
      <button class="action ${post.viewerBookmarked ? 'is-active' : ''}" type="button"
              data-bookmark data-post-id="${post.id}"
              aria-pressed="${post.viewerBookmarked ? 'true' : 'false'}" aria-label="Bookmark">
        ${icon('bookmark')} <span>Bookmark</span>
      </button>
      <span class="postcard__more">
        ${reactionBar(post)}
        ${post.canEdit ? raw(html`<a class="action" href="/compose?edit=${post.id}">Edit</a>`) : ''}
        ${post.canDelete
          ? raw(html`<button class="action action--danger" type="button" data-delete-post data-post-id="${post.id}">Delete</button>`)
          : ''}
        ${!post.canEdit
          ? raw(html`<button class="action" type="button" data-report data-target-type="post" data-target-id="${post.id}">Report</button>`)
          : ''}
      </span>
    </div>
  `);
}

function header(post: PostDTO): RawHtml {
  return raw(html`
    <header class="postcard__head">
      ${avatar(post.author, 'md')}
      <div class="postcard__meta">
        <a class="postcard__author" href="/u/${post.author.username}">${post.author.displayName || post.author.username}</a>
        <span class="postcard__sub">
          <a href="/u/${post.author.username}">@${post.author.username}</a>
          · <time datetime="${toIso(post.createdAt)}" title="${toIso(post.createdAt)}">${relativeTime(post.createdAt)}</time>
          ${post.editedAt ? raw(html`· <span class="muted">edited</span>`) : ''}
          ${post.visibility !== 'public'
            ? raw(html`· <span class="pill pill--muted">${post.visibility === 'followers' ? 'Followers' : 'Private'}</span>`)
            : ''}
        </span>
      </div>
      ${post.category
        ? raw(html`<a class="pill pill--category" href="/category/${post.category.slug}" style="--cat:${post.category.color}">${post.category.name}</a>`)
        : ''}
    </header>
  `);
}

/** Compact card used in every feed. */
export function postCard(post: PostDTO): string {
  const permalink = `/post/${post.slug}`;
  return html`
    <article class="postcard" data-post-card data-post-id="${post.id}" aria-labelledby="post-${post.id}-title">
      ${header(post)}
      <div class="postcard__body">
        ${post.title
          ? raw(html`<h2 class="postcard__title" id="post-${post.id}-title"><a href="${permalink}">${post.title}</a></h2>`)
          : raw(html`<h2 class="sr-only" id="post-${post.id}-title">Post by ${post.author.username}</h2>`)}
        <div class="prose prose--clamp">${raw(post.html)}</div>
        ${post.contentType === 'link' && post.linkUrl
          ? raw(html`<a class="linkcard" href="${post.linkUrl}" rel="noopener nofollow" target="_blank">
              <span class="linkcard__host">${safeHost(post.linkUrl)}</span>
              <span class="linkcard__url">${post.linkUrl}</span>
            </a>`)
          : ''}
        ${mediaGrid(post)}
        ${tagList(post)}
      </div>
      ${actionBar(post, permalink)}
    </article>
  `;
}

/** Full article view on `/post/{slug}`. */
export function postArticle(post: PostDTO): string {
  const permalink = `/post/${post.slug}`;
  return html`
    <article class="post" data-post-card data-post-id="${post.id}">
      ${header(post)}
      ${post.title ? raw(html`<h1 class="post__title">${post.title}</h1>`) : ''}
      <div class="prose">${raw(post.html)}</div>
      ${post.contentType === 'link' && post.linkUrl
        ? raw(html`<a class="linkcard" href="${post.linkUrl}" rel="noopener nofollow" target="_blank">
            <span class="linkcard__host">${safeHost(post.linkUrl)}</span>
            <span class="linkcard__url">${post.linkUrl}</span>
          </a>`)
        : ''}
      ${mediaGrid(post)}
      ${tagList(post)}
      ${actionBar(post, permalink)}
    </article>
  `;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'link';
  }
}

export function emptyState(title: string, body: string, cta?: { href: string; label: string }): string {
  return html`
    <div class="empty">
      <p class="empty__title">${title}</p>
      <p class="empty__body">${body}</p>
      ${cta ? raw(html`<a class="btn btn--primary" href="${cta.href}">${cta.label}</a>`) : ''}
    </div>
  `;
}
