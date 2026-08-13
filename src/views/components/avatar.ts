/**
 * Avatar rendering.
 *
 * Avatars are always served through the Worker (`/media/{id}`) — the storage
 * bucket is never addressed by the browser, so bucket names and credentials
 * stay server-side. Users without an uploaded image get a deterministic
 * initials chip instead of an external gravatar request.
 */

import { escapeHtml, html, raw, type RawHtml } from '../../utils/html';
import type { PublicUser } from '../../types/models';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export function avatarUrl(mediaId: string | null | undefined, variant: 'thumb' | 'original' = 'thumb'): string | null {
  if (!mediaId) return null;
  return variant === 'original' ? `/media/${encodeURIComponent(mediaId)}` : `/media/${encodeURIComponent(mediaId)}?v=thumb`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return (parts[0] ?? '?').slice(0, 2).toUpperCase();
  return `${(parts[0] ?? '')[0] ?? ''}${(parts[1] ?? '')[0] ?? ''}`.toUpperCase();
}

/** Stable hue from the user id, so the fallback chip is recognisable. */
function hueFor(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  return hash;
}

const PX: Record<AvatarSize, number> = { xs: 24, sm: 32, md: 40, lg: 56, xl: 96 };

export interface AvatarInput {
  id: string;
  username: string;
  displayName: string;
  avatarMediaId: string | null;
}

export function avatar(user: AvatarInput, size: AvatarSize = 'md', link = true): RawHtml {
  const px = PX[size];
  const url = avatarUrl(user.avatarMediaId, size === 'xl' ? 'original' : 'thumb');
  const inner = url
    ? html`<img src="${url}" alt="" width="${px}" height="${px}" loading="lazy" decoding="async">`
    : html`<span class="avatar__fallback" style="--hue:${hueFor(user.id)}" aria-hidden="true">${initials(
        user.displayName || user.username,
      )}</span>`;

  const classes = `avatar avatar--${size}`;
  if (!link) return raw(html`<span class="${classes}">${raw(inner)}</span>`);
  return raw(
    html`<a class="${classes}" href="/u/${user.username}" aria-label="${user.displayName || user.username}'s profile">${raw(
      inner,
    )}</a>`,
  );
}

/** Name + @handle + level pill, used above posts and comments. */
export function userChip(user: PublicUser, size: AvatarSize = 'md'): RawHtml {
  return raw(html`
    <div class="userchip">
      ${avatar(user, size)}
      <div class="userchip__meta">
        <a class="userchip__name" href="/u/${user.username}">
          ${user.displayName || user.username}
          ${user.role === 'admin' || user.role === 'moderator'
            ? raw(
                `<span class="pill pill--staff" title="${escapeHtml(user.role)}">${escapeHtml(
                  user.role === 'admin' ? 'Admin' : 'Mod',
                )}</span>`,
              )
            : ''}
        </a>
        <span class="userchip__handle">@${user.username} · <span class="pill pill--level">Lv ${user.level}</span></span>
      </div>
    </div>
  `);
}
