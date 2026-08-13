/**
 * `/settings` — profile, appearance, media library, security, sessions and
 * account deletion.
 *
 * Every section is a plain form posting to the API with a CSRF field. Nothing
 * here trusts the client: the API re-validates and re-authorises each call.
 */

import { html, raw } from '../../utils/html';
import type { AuthUser, MediaDTO, PublicUser } from '../../types/models';
import { LIMITS } from '../../config';
import { relativeTime, toIso } from '../../utils/time';
import { avatarUrl } from '../components/avatar';

export interface SessionRow {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  current: boolean;
}

export interface SettingsPageInput {
  user: AuthUser;
  profile: PublicUser;
  sessions: SessionRow[];
  media: MediaDTO[];
  csrfToken: string | null;
  theme: 'light' | 'dark' | 'system';
}

export function renderSettingsPage(input: SettingsPageInput): string {
  const csrf = input.csrfToken ?? '';
  const avatar = avatarUrl(input.profile.avatarMediaId, 'original');

  return html`
    <div class="pagehead">
      <h1 class="pagehead__title">Settings</h1>
      <p class="pagehead__sub muted">Signed in as @${input.user.username}</p>
    </div>

    <nav class="tabs" aria-label="Settings sections">
      <a class="tab" href="#profile">Profile</a>
      <a class="tab" href="#appearance">Appearance</a>
      <a class="tab" href="#media">Media</a>
      <a class="tab" href="#security">Security</a>
      <a class="tab" href="#filters">Filters</a>
      <a class="tab" href="#danger">Account</a>
    </nav>

    <section class="panel" id="profile" aria-labelledby="profile-title">
      <h2 class="panel__title" id="profile-title">Profile</h2>

      <form class="form" method="post" action="/api/me/profile" data-settings-form data-method="PATCH">
        <input type="hidden" name="_csrf" value="${csrf}">

        <div class="field">
          <label for="displayName">Display name</label>
          <input id="displayName" name="displayName" type="text" maxlength="${LIMITS.displayNameMax}"
                 value="${input.profile.displayName}">
        </div>

        <div class="field">
          <label for="bio">Bio</label>
          <textarea id="bio" name="bio" rows="3" maxlength="${LIMITS.bioMax}">${input.profile.bio}</textarea>
          <p class="field__hint">Up to ${LIMITS.bioMax} characters. Plain text only.</p>
        </div>

        <div class="field">
          <label for="location">Location</label>
          <input id="location" name="location" type="text" maxlength="80" value="${input.profile.location}">
        </div>

        <div class="field">
          <label for="website">Website</label>
          <input id="website" name="website" type="url" maxlength="200" value="${input.profile.website}"
                 placeholder="https://example.com">
        </div>

        <button class="btn btn--primary" type="submit">Save profile</button>
        <p class="form__error" data-form-error role="alert" hidden></p>
      </form>

      <h3 class="panel__subtitle">Avatar</h3>
      <div class="avatarrow">
        <span class="avatar avatar--xl">
          ${avatar
            ? raw(html`<img src="${avatar}" alt="Your current avatar" width="96" height="96">`)
            : raw(html`<span class="avatar__fallback" aria-hidden="true">${(input.profile.displayName || input.profile.username).slice(0, 2).toUpperCase()}</span>`)}
        </span>

        <form class="form form--inline" method="post" action="/api/media/upload" enctype="multipart/form-data"
              data-avatar-form>
          <input type="hidden" name="_csrf" value="${csrf}">
          <input type="hidden" name="usage" value="avatar">
          <label class="filebtn">
            <input type="file" name="file" accept="image/png,image/jpeg,image/webp" required>
            <span>Choose image</span>
          </label>
          <button class="btn btn--primary" type="submit">Upload avatar</button>
        </form>

        ${input.profile.avatarMediaId
          ? raw(html`
              <form method="post" action="/api/me/avatar" data-settings-form data-method="DELETE" data-reload="1">
                <input type="hidden" name="_csrf" value="${csrf}">
                <button class="btn btn--ghost" type="submit">Remove avatar</button>
              </form>`)
          : ''}
      </div>
    </section>

    <section class="panel" id="appearance" aria-labelledby="appearance-title">
      <h2 class="panel__title" id="appearance-title">Appearance</h2>
      <p class="muted">The theme is stored in a cookie on this device. It respects your system setting by default.</p>
      <div class="themepicker" role="group" aria-label="Colour theme">
        ${(['light', 'dark', 'system'] as const).map(
          (option) => raw(html`
            <button class="btn ${input.theme === option ? 'btn--primary' : 'btn--ghost'}" type="button"
                    data-theme-set="${option}" aria-pressed="${input.theme === option ? 'true' : 'false'}">
              ${option === 'light' ? 'Light' : option === 'dark' ? 'Dark' : 'System'}
            </button>`),
        )}
      </div>
    </section>

    <section class="panel" id="media" aria-labelledby="media-title">
      <h2 class="panel__title" id="media-title">Your media</h2>
      ${input.media.length
        ? raw(html`
            <ul class="medialist" data-media-list>
              ${input.media.map(
                (item) => raw(html`
                  <li class="medialist__item" data-media-id="${item.id}">
                    <img src="${item.thumbUrl}" alt="" width="96" height="96" loading="lazy">
                    <div class="medialist__meta">
                      <span class="muted">${item.mimeType} · ${Math.round(item.size / 1024)} KB</span>
                      <time class="muted" datetime="${toIso(item.createdAt)}">${relativeTime(item.createdAt)}</time>
                    </div>
                    <form method="post" action="/api/media/${item.id}" data-settings-form data-method="DELETE" data-reload="1">
                      <input type="hidden" name="_csrf" value="${csrf}">
                      <button class="btn btn--small btn--danger" type="submit">Delete</button>
                    </form>
                  </li>`),
              )}
            </ul>`)
        : raw(html`<p class="muted">You have not uploaded anything yet.</p>`)}
    </section>

    <section class="panel" id="security" aria-labelledby="security-title">
      <h2 class="panel__title" id="security-title">Password</h2>
      <form class="form" method="post" action="/api/auth/password" data-settings-form>
        <input type="hidden" name="_csrf" value="${csrf}">
        <div class="field">
          <label for="currentPassword">Current password</label>
          <input id="currentPassword" name="currentPassword" type="password" required autocomplete="current-password"
                 minlength="${LIMITS.passwordMin}" maxlength="${LIMITS.passwordMax}">
        </div>
        <div class="field">
          <label for="newPassword">New password</label>
          <input id="newPassword" name="newPassword" type="password" required autocomplete="new-password"
                 minlength="${LIMITS.passwordMin}" maxlength="${LIMITS.passwordMax}">
        </div>
        <button class="btn btn--primary" type="submit">Change password</button>
        <p class="form__error" data-form-error role="alert" hidden></p>
      </form>

      <h3 class="panel__subtitle">Active sessions</h3>
      <ul class="sessionlist">
        ${input.sessions.map(
          (session) => raw(html`
            <li class="sessionlist__item">
              <div>
                <strong>${session.current ? 'This device' : 'Another device'}</strong>
                <p class="muted">
                  Started <time datetime="${toIso(session.createdAt)}">${relativeTime(session.createdAt)}</time> ·
                  last seen <time datetime="${toIso(session.lastSeenAt)}">${relativeTime(session.lastSeenAt)}</time>
                </p>
              </div>
              ${session.current
                ? raw(html`<span class="pill pill--muted">Current</span>`)
                : raw(html`
                    <form method="post" action="/api/auth/sessions/${session.id}" data-settings-form data-method="DELETE" data-reload="1">
                      <input type="hidden" name="_csrf" value="${csrf}">
                      <button class="btn btn--small btn--ghost" type="submit">Sign out</button>
                    </form>`)}
            </li>`),
        )}
      </ul>

      <form class="form form--inline" method="post" action="/api/auth/logout-all" data-settings-form data-reload="1">
        <input type="hidden" name="_csrf" value="${csrf}">
        <button class="btn btn--ghost" type="submit">Sign out everywhere</button>
      </form>
    </section>

    <section class="panel" id="filters" aria-labelledby="filters-title">
      <h2 class="panel__title" id="filters-title">Mutes & digest</h2>
      <form class="form" method="post" action="/api/community/mutes" data-settings-form>
        <input type="hidden" name="_csrf" value="${csrf}">
        <input type="hidden" name="kind" value="word">
        <div class="field">
          <label for="mute-word">Mute a word</label>
          <input id="mute-word" name="word" type="text" maxlength="40" placeholder="spam">
        </div>
        <button class="btn btn--primary" type="submit">Mute word</button>
      </form>
      <form class="form" method="post" action="/api/community/prefs/digest" data-settings-form>
        <input type="hidden" name="_csrf" value="${csrf}">
        <label class="checkbox"><input type="checkbox" name="enabled" value="1" checked> In-app digest of new posts</label>
        <button class="btn btn--ghost" type="submit">Save digest</button>
      </form>
    </section>

    <section class="panel panel--danger" id="danger" aria-labelledby="danger-title">
      <h2 class="panel__title" id="danger-title">Delete account</h2>
      <p class="muted">
        Your profile and posts are removed from the site immediately. Media files are queued for
        permanent deletion from object storage. This cannot be undone.
      </p>
      <form class="form" method="post" action="/api/auth/delete-account" data-settings-form data-redirect="/">
        <input type="hidden" name="_csrf" value="${csrf}">
        <div class="field">
          <label for="deletePassword">Confirm your password</label>
          <input id="deletePassword" name="password" type="password" required autocomplete="current-password"
                 minlength="${LIMITS.passwordMin}" maxlength="${LIMITS.passwordMax}">
        </div>
        <div class="field">
          <label for="confirm">Type DELETE to confirm</label>
          <input id="confirm" name="confirm" type="text" required pattern="DELETE" placeholder="DELETE">
        </div>
        <button class="btn btn--danger" type="submit">Delete my account</button>
        <p class="form__error" data-form-error role="alert" hidden></p>
      </form>
    </section>
  `;
}
