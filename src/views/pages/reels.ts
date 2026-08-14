/**
 * `/reels` — a full-height, scroll-snapping column of short vertical videos.
 *
 * Every reel is server-rendered, so the page is a working list of videos with
 * JavaScript disabled: uploads use a plain `<video controls>` and embeds use
 * the source platform's own iframe player. The client only adds the niceties —
 * play/pause on scroll, keyboard navigation and optimistic likes.
 *
 * Embedded reels are never proxied or re-hosted: the iframe points straight at
 * YouTube / TikTok / Instagram / Facebook, which is what keeps this compliant
 * with each platform's terms and means we store no video bytes at all.
 */

import { html, raw } from '../../utils/html';
import type { Page, ReelDTO } from '../../types/models';
import { playableEmbedUrl } from '../../services/reelSources';
import { relativeTime, toIso } from '../../utils/time';
import { avatar } from '../components/avatar';
import { emptyState } from '../components/post';
import { icon } from '../layout';

export interface ReelsPageInput {
  page: Page<ReelDTO>;
  sort: 'latest' | 'popular';
  csrfToken: string | null;
  signedIn: boolean;
}

/**
 * The video surface.
 *
 * The first reel in the feed starts fetching immediately (preload / eager
 * iframe). Later ones keep a poster until they enter view or are tapped, so
 * opening the page does not spawn a YouTube spinner on every card.
 */
function player(reel: ReelDTO, eager: boolean): string {
  const poster = reel.posterUrl || '';
  const posterEl = html`
    <button class="reel__poster ${poster ? '' : 'reel__poster--plain'}" type="button"
            data-reel-poster data-reel-activate
            ${poster ? raw(html`style="background-image:url('${poster}')"`) : ''}
            aria-label="Play reel">
      <span class="reel__play" aria-hidden="true"></span>
    </button>
  `;

  if (reel.provider === 'upload' && reel.videoUrl) {
    return html`
      ${raw(posterEl)}
      <video
        class="reel__video"
        src="${reel.videoUrl}"
        ${poster ? raw(html`poster="${poster}"`) : ''}
        playsinline
        loop
        muted
        controls
        preload="${eager ? 'auto' : 'metadata'}"
        data-reel-video
      ></video>
    `;
  }

  if (!reel.embedUrl) {
    return html`<div class="reel__missing muted">This video is no longer available.</div>`;
  }

  const playable = playableEmbedUrl(reel.embedUrl);
  return html`
    ${raw(posterEl)}
    <iframe
      class="reel__embed"
      ${eager ? raw(html`src="${playable}"`) : ''}
      data-src="${playable}"
      title="${reel.title || `${reel.providerLabel} video by @${reel.author.username}`}"
      loading="${eager ? 'eager' : 'lazy'}"
      referrerpolicy="strict-origin-when-cross-origin"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      allowfullscreen
      data-reel-embed
    ></iframe>
  `;
}

function reelCard(reel: ReelDTO, csrfToken: string | null, signedIn: boolean, eager: boolean): string {
  return html`
    <article class="reel" data-reel data-reel-id="${reel.id}" aria-label="${reel.title || 'Reel'}">
      <div class="reel__stage ${eager ? 'is-active' : ''}" data-reel-stage
           data-provider="${reel.provider}" data-poster="${reel.posterUrl || ''}">
        ${raw(player(reel, eager))}
      </div>

      <div class="reel__meta">
        <div class="reel__author">
          ${avatar(
            {
              id: reel.author.id,
              username: reel.author.username,
              displayName: reel.author.displayName,
              avatarMediaId: reel.author.avatarMediaId,
            },
            'sm',
          )}
          <div class="reel__who">
            <a class="reel__name" href="/u/${reel.author.username}">${reel.author.displayName}</a>
            <span class="reel__handle muted">
              @${reel.author.username} ·
              <time datetime="${toIso(reel.createdAt)}">${relativeTime(reel.createdAt)}</time>
            </span>
          </div>
          <span class="pill pill--source">${reel.providerLabel}</span>
        </div>

        ${reel.title ? raw(html`<h2 class="reel__title">${reel.title}</h2>`) : ''}
        ${reel.caption ? raw(html`<p class="reel__caption">${reel.caption}</p>`) : ''}

        <div class="reel__actions">
          ${signedIn && csrfToken
            ? raw(html`
                <form method="post" action="/api/reels/${reel.id}/like" data-reel-like>
                  <input type="hidden" name="_csrf" value="${csrfToken}">
                  <button
                    class="reel__action ${reel.viewerLiked ? 'is-on' : ''}"
                    type="submit"
                    aria-pressed="${reel.viewerLiked ? 'true' : 'false'}"
                    aria-label="Like this reel"
                  >
                    ${icon('heart')}<span data-reel-likes>${reel.likeCount}</span>
                  </button>
                </form>`)
            : raw(html`
                <a class="reel__action" href="/login?next=/reels" aria-label="Sign in to like">
                  ${icon('heart')}<span>${reel.likeCount}</span>
                </a>`)}

          <span class="reel__action reel__action--static" title="Views">
            ${icon('activity')}<span>${reel.viewCount}</span>
          </span>

          ${reel.sourceUrl
            ? raw(html`
                <a class="reel__action" href="${reel.sourceUrl}" target="_blank" rel="noopener noreferrer nofollow">
                  ${icon('share')}<span>Watch on ${reel.providerLabel}</span>
                </a>`)
            : ''}
        </div>
      </div>
    </article>
  `;
}

/** Import/upload panel. A real form, so it works before the client boots. */
export function reelComposer(csrfToken: string | null): string {
  if (!csrfToken) return '';
  return html`
    <details class="reelcomposer">
      <summary class="reelcomposer__summary">
        <span>Add a reel</span>
        <span class="muted">Paste a YouTube Shorts, TikTok, Instagram or Facebook link — or upload your own</span>
      </summary>

      <div class="reelcomposer__body">
        <form class="form" method="post" action="/api/reels/import" data-reel-import>
          <input type="hidden" name="_csrf" value="${csrfToken}">
          <label class="field">
            <span class="field__label">Video link</span>
            <input class="field__input" name="url" type="url" required maxlength="2000"
                   placeholder="https://www.youtube.com/shorts/… · https://www.tiktok.com/@user/video/…">
          </label>
          <label class="field">
            <span class="field__label">Caption <span class="muted">(optional)</span></span>
            <input class="field__input" name="caption" type="text" maxlength="600"
                   placeholder="Why is this worth watching?">
          </label>
          <p class="field__hint muted">
            The video keeps playing from its original platform — AES stores only the link, never a copy.
            Short share links (vm.tiktok.com, fb.watch) need to be opened once so they expand to the full URL.
          </p>
          <button class="btn btn--primary" type="submit">Import reel</button>
        </form>

        <form class="form" method="post" action="/api/reels" data-reel-upload enctype="multipart/form-data">
          <input type="hidden" name="_csrf" value="${csrfToken}">
          <label class="filebtn">
            <input type="file" name="file" accept="video/mp4,video/webm" data-reel-file>
            <span>Upload a video (MP4 or WebM)</span>
          </label>
          <label class="field">
            <span class="field__label">Caption <span class="muted">(optional)</span></span>
            <input class="field__input" name="caption" type="text" maxlength="600" placeholder="Say something">
          </label>
          <button class="btn btn--ghost" type="submit">Publish upload</button>
        </form>
      </div>
    </details>
  `;
}

export function renderReelsPage(input: ReelsPageInput): string {
  const { page } = input;

  return html`
    <div class="pagehead">
      <h1 class="pagehead__title">Reels</h1>
      <p class="pagehead__sub muted">Short vertical video from the community — and from across the web.</p>
    </div>

    <nav class="tabs" aria-label="Reel sort">
      <a class="tab ${input.sort === 'latest' ? 'is-active' : ''}" href="/reels"
         ${input.sort === 'latest' ? raw('aria-current="page"') : ''}>Latest</a>
      <a class="tab ${input.sort === 'popular' ? 'is-active' : ''}" href="/reels?sort=popular"
         ${input.sort === 'popular' ? raw('aria-current="page"') : ''}>Popular</a>
    </nav>

    ${raw(reelComposer(input.csrfToken))}

    ${page.items.length
      ? raw(html`
          <div class="reelfeed" data-reel-feed>
            ${page.items.map((reel, index) => raw(reelCard(reel, input.csrfToken, input.signedIn, index === 0)))}
          </div>
          ${page.hasMore && page.nextCursor
            ? raw(html`
                <div class="loadmore">
                  <a class="btn btn--ghost btn--block" href="/reels?sort=${input.sort}&cursor=${page.nextCursor}"
                     data-reel-more data-cursor="${page.nextCursor}">Load more reels</a>
                </div>`)
            : ''}`)
      : raw(
          emptyState(
            'No reels yet',
            'Paste a link to a short video, or upload one of your own — it will show up right here.',
            { href: '/explore', label: 'Explore posts instead' },
          ),
        )}
  `;
}
