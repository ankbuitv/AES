/**
 * Progressive-enhancement bundle.
 *
 * Every feature on the site works without this file: forms post normally,
 * "load more" links navigate, reactions are ordinary form submissions. This
 * script upgrades those interactions in place — it is not an SPA, there is no
 * router, and it never renders a page from scratch.
 *
 * Security notes:
 *   - the CSRF token is read from `<meta name="csrf-token">` and echoed in the
 *     `x-csrf-token` header on every mutating request
 *   - server HTML is inserted only through the sanitised fields the API
 *     returns (`post.html`, `comment.html`), which the Worker escapes; all
 *     other interpolation uses textContent
 *   - authorisation is never decided here; the UI only hides what the server
 *     already refuses
 */

interface Bootstrap {
  user: { id: string; username: string; role: string } | null;
  csrfToken: string | null;
  origin: string;
  [key: string]: unknown;
}

declare global {
  interface Window {
    __ANK__?: Bootstrap;
  }
}

const boot: Bootstrap = window.__ANK__ ?? { user: null, csrfToken: null, origin: location.origin };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function $<T extends Element = Element>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(selector);
}

function $$<T extends Element = Element>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

function csrfToken(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]');
  return meta?.content || boot.csrfToken || '';
}

function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const host = $('[data-toaster]');
  if (!host) return;
  const el = document.createElement('div');
  el.className = kind === 'error' ? 'toast toast--error' : 'toast';
  el.textContent = message;
  host.appendChild(el);
  window.setTimeout(() => el.remove(), 4200);
}

interface ApiEnvelope<T> {
  success: boolean;
  data: T | null;
  error: { code: string; message: string; details?: unknown } | null;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  headers.set('x-requested-with', 'fetch');
  if (method !== 'GET' && method !== 'HEAD') headers.set('x-csrf-token', csrfToken());

  const response = await fetch(path, { ...init, method, headers, credentials: 'same-origin' });

  let payload: ApiEnvelope<T> | null = null;
  try {
    payload = (await response.json()) as ApiEnvelope<T>;
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.success) {
    const retryAfter = response.headers.get('retry-after');
    const message =
      payload?.error?.message ??
      (response.status === 429 && retryAfter
        ? `Too many requests. Try again in ${retryAfter}s.`
        : 'Something went wrong.');
    throw new ApiError(message, payload?.error?.code ?? 'HTTP_ERROR', response.status);
  }

  return payload.data as T;
}

/** Serialise a form, minus the CSRF field which travels as a header. */
function formPayload(form: HTMLFormElement): FormData {
  const data = new FormData(form);
  return data;
}

function busy(form: HTMLFormElement, state: boolean): void {
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.disabled = state;
  form.setAttribute('aria-busy', state ? 'true' : 'false');
}

function showFormError(form: HTMLFormElement, message: string | null): void {
  const target = form.querySelector<HTMLElement>('[data-form-error]');
  if (!target) {
    if (message) toast(message, 'error');
    return;
  }
  target.textContent = message ?? '';
  target.hidden = !message;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

type Theme = 'light' | 'dark' | 'system';

function applyTheme(theme: Theme): void {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.dataset.theme = theme;
  document.cookie = `ank_theme=${theme}; path=/; max-age=31536000; samesite=lax${
    location.protocol === 'https:' ? '; secure' : ''
  }`;
  const icon = $('[data-theme-icon]');
  if (icon) icon.textContent = dark ? '☾' : '☀';
  for (const button of $$<HTMLButtonElement>('[data-theme-set]')) {
    const pressed = button.dataset.themeSet === theme;
    button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    button.classList.toggle('btn--primary', pressed);
    button.classList.toggle('btn--ghost', !pressed);
  }
}

function currentTheme(): Theme {
  const value = document.documentElement.dataset.theme;
  return value === 'light' || value === 'dark' ? value : 'system';
}

function initTheme(): void {
  applyTheme(currentTheme());

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;

    const toggle = target?.closest('[data-theme-toggle]');
    if (toggle) {
      const next: Theme = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
      applyTheme(next);
      return;
    }

    const setter = target?.closest<HTMLElement>('[data-theme-set]');
    if (setter) {
      applyTheme((setter.dataset.themeSet as Theme) || 'system');
    }
  });
}

// ---------------------------------------------------------------------------
// Reactions, bookmarks, share, delete, report
// ---------------------------------------------------------------------------

interface ReactionResponse {
  reaction: string | null;
  count: number;
}

async function handleReaction(button: HTMLElement): Promise<void> {
  const group = button.closest<HTMLElement>('[data-reactions]');
  if (!group) return;
  const targetType = group.dataset.targetType ?? 'post';
  const targetId = group.dataset.targetId ?? '';
  const type = button.dataset.reaction ?? 'like';
  if (!targetId) return;

  const endpoint =
    targetType === 'comment'
      ? `/api/comments/${encodeURIComponent(targetId)}/reactions`
      : `/api/posts/${encodeURIComponent(targetId)}/reactions`;

  try {
    const body = new FormData();
    body.set('reaction', type);
    const data = await api<ReactionResponse>(endpoint, { method: 'POST', body });

    for (const other of $$<HTMLElement>('[data-reaction]', group)) {
      const active = other.dataset.reaction === data.reaction;
      other.classList.toggle('is-active', active);
      other.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    const count = $('[data-reaction-count]', group);
    if (count) count.textContent = String(data.count);
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Could not react', 'error');
  }
}

async function handleBookmark(button: HTMLElement): Promise<void> {
  const postId = button.dataset.postId ?? '';
  if (!postId) return;
  try {
    const data = await api<{ bookmarked: boolean; count: number }>(
      `/api/posts/${encodeURIComponent(postId)}/bookmark`,
      { method: 'POST' },
    );
    button.classList.toggle('is-active', data.bookmarked);
    button.setAttribute('aria-pressed', data.bookmarked ? 'true' : 'false');
    toast(data.bookmarked ? 'Saved to bookmarks' : 'Removed from bookmarks');
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Could not save', 'error');
  }
}

async function handleShare(button: HTMLElement): Promise<void> {
  const url = button.dataset.url ?? location.href;
  const title = button.dataset.title ?? document.title;
  const card = button.closest<HTMLElement>('[data-post-card]');
  const postId = card?.dataset.postId;

  try {
    if (navigator.share) {
      await navigator.share({ title, url });
    } else {
      await navigator.clipboard.writeText(url);
      toast('Link copied to clipboard');
    }
    if (postId) {
      // Fire-and-forget: the share counter must never block the UI.
      void api(`/api/posts/${encodeURIComponent(postId)}/share`, { method: 'POST' }).catch(
        () => undefined,
      );
    }
  } catch {
    /* user dismissed the share sheet */
  }
}

async function handleDeletePost(button: HTMLElement): Promise<void> {
  const postId = button.dataset.postId ?? '';
  if (!postId || !window.confirm('Delete this post? This cannot be undone.')) return;
  try {
    await api(`/api/posts/${encodeURIComponent(postId)}`, { method: 'DELETE' });
    const card = button.closest<HTMLElement>('[data-post-card]');
    if (card && card.classList.contains('postcard')) card.remove();
    else location.href = '/';
    toast('Post deleted');
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Could not delete', 'error');
  }
}

async function handleReport(button: HTMLElement): Promise<void> {
  const targetType = button.dataset.targetType ?? 'post';
  const targetId = button.dataset.targetId ?? '';
  if (!targetId) return;

  const reason = window.prompt(
    'Why are you reporting this? (spam, harassment, hate, violence, nsfw, misinformation, illegal, other)',
    'spam',
  );
  if (!reason) return;
  const description = window.prompt('Anything else we should know? (optional)', '') ?? '';

  try {
    const body = new FormData();
    body.set('targetType', targetType);
    body.set('targetId', targetId);
    body.set('reason', reason.trim().toLowerCase());
    body.set('description', description);
    await api('/api/reports', { method: 'POST', body });
    toast('Thanks — our moderators will review this.');
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Could not send report', 'error');
  }
}

// ---------------------------------------------------------------------------
// Follow
// ---------------------------------------------------------------------------

async function handleFollowForm(form: HTMLFormElement): Promise<void> {
  const button = form.querySelector<HTMLButtonElement>('[data-follow]');
  const username = button?.dataset.username ?? '';
  if (!username || !button) return;

  const following = button.getAttribute('aria-pressed') === 'true';
  const endpoint = `/api/users/${encodeURIComponent(username)}/follow`;

  busy(form, true);
  try {
    const data = await api<{ following: boolean; followerCount?: number }>(endpoint, {
      method: following ? 'DELETE' : 'POST',
    });
    const nowFollowing = data.following ?? !following;
    button.setAttribute('aria-pressed', nowFollowing ? 'true' : 'false');
    button.textContent = nowFollowing ? 'Following' : 'Follow';
    button.classList.toggle('btn--primary', !nowFollowing);
    button.classList.toggle('btn--ghost', nowFollowing);
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Could not update follow', 'error');
  } finally {
    busy(form, false);
  }
}

// ---------------------------------------------------------------------------
// Feeds: cursor "load more"
// ---------------------------------------------------------------------------

interface PostDTOLike {
  id: string;
  slug: string;
  title: string;
  html: string;
  excerpt: string;
  createdAt: number;
  commentCount: number;
  reactionCount: number;
  author: { username: string; displayName: string; avatarMediaId: string | null; level: number };
}

interface PageLike<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

/**
 * Minimal client-side card. Deliberately simpler than the server template:
 * the sanitised `html` field is inserted as-is (the Worker produced it), while
 * every other value goes through `escapeHtml`.
 */
function renderPostCard(post: PostDTOLike): string {
  const author = post.author;
  return `<article class="postcard" data-post-card data-post-id="${escapeHtml(post.id)}">
    <div class="postcard__head">
      <div class="postcard__author">
        <a class="avatar avatar--md" href="/u/${encodeURIComponent(author.username)}">${
          author.avatarMediaId
            ? `<img src="/media/${encodeURIComponent(author.avatarMediaId)}?v=thumb" alt="" width="40" height="40" loading="lazy">`
            : `<span class="avatar__fallback" aria-hidden="true">${escapeHtml(
                (author.displayName || author.username).slice(0, 2).toUpperCase(),
              )}</span>`
        }</a>
        <div class="userchip__meta">
          <a class="userchip__name" href="/u/${encodeURIComponent(author.username)}">${escapeHtml(
            author.displayName || author.username,
          )}</a>
          <span class="userchip__handle">@${escapeHtml(author.username)} · Lv ${author.level}</span>
        </div>
      </div>
    </div>
    ${post.title ? `<h2 class="postcard__title"><a href="/post/${encodeURIComponent(post.slug)}">${escapeHtml(post.title)}</a></h2>` : ''}
    <div class="postcard__body prose prose--sm prose--clamp">${post.html}</div>
    <p class="postcard__meta"><a href="/post/${encodeURIComponent(post.slug)}">${post.reactionCount} reactions · ${post.commentCount} comments</a></p>
  </article>`;
}

async function loadMoreFeed(trigger: HTMLElement): Promise<void> {
  const container =
    trigger.closest('.main')?.querySelector<HTMLElement>('[data-feed]') ??
    $<HTMLElement>('[data-feed]');
  const endpoint = container?.dataset.endpoint;
  const cursor = trigger.dataset.cursor;
  if (!container || !endpoint || !cursor) return;

  const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`;
  trigger.setAttribute('aria-busy', 'true');

  try {
    const page = await api<PageLike<PostDTOLike>>(url);
    container.insertAdjacentHTML('beforeend', page.items.map(renderPostCard).join(''));
    if (page.nextCursor) {
      trigger.dataset.cursor = page.nextCursor;
      if (trigger instanceof HTMLAnchorElement) {
        const base = trigger.href.split('?')[0] ?? trigger.href;
        trigger.href = `${base}?cursor=${encodeURIComponent(page.nextCursor)}`;
      }
    } else {
      trigger.remove();
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Could not load more', 'error');
  } finally {
    trigger.removeAttribute('aria-busy');
  }
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

interface CommentDTOLike {
  id: string;
  html: string;
  depth: number;
  createdAt: number;
  author: { username: string; displayName: string; avatarMediaId: string | null };
}

function renderComment(comment: CommentDTOLike): string {
  return `<li class="comment" data-comment-id="${escapeHtml(comment.id)}" data-depth="${comment.depth}">
    <div class="comment__head">
      <a class="comment__author" href="/u/${encodeURIComponent(comment.author.username)}">${escapeHtml(
        comment.author.displayName || comment.author.username,
      )}</a>
      <span class="comment__sub">just now</span>
    </div>
    <div class="comment__body prose prose--sm">${comment.html}</div>
  </li>`;
}

async function submitComment(form: HTMLFormElement): Promise<void> {
  busy(form, true);
  showFormError(form, null);
  try {
    const data = await api<{ comment: CommentDTOLike }>(form.action, {
      method: 'POST',
      body: formPayload(form),
    });

    const list = $('[data-comment-list]');
    const parentInput = form.querySelector<HTMLInputElement>('[data-parent-input]');
    const parentId = parentInput?.value;

    if (parentId) {
      const parent = $(`[data-comment-id="${CSS.escape(parentId)}"]`);
      let replies = parent?.querySelector<HTMLElement>('.comment__replies');
      if (parent && !replies) {
        replies = document.createElement('ul');
        replies.className = 'comment__replies';
        parent.appendChild(replies);
      }
      replies?.insertAdjacentHTML('beforeend', renderComment(data.comment));
    } else if (list) {
      list.insertAdjacentHTML('afterbegin', renderComment(data.comment));
    }

    form.reset();
    if (parentInput) parentInput.value = '';
    const replying = form.querySelector<HTMLElement>('[data-replying]');
    if (replying) replying.hidden = true;
    updateCharCount(form);
    toast('Comment posted');
  } catch (error) {
    showFormError(form, error instanceof Error ? error.message : 'Could not post comment');
  } finally {
    busy(form, false);
  }
}

function startReply(button: HTMLElement): void {
  const form = $<HTMLFormElement>('[data-comment-form]');
  if (!form) return;

  const commentId = button.closest<HTMLElement>('[data-comment-id]')?.dataset.commentId ?? '';
  const author =
    button.closest<HTMLElement>('[data-comment-id]')?.querySelector('.comment__author')
      ?.textContent ?? 'this comment';

  const parentInput = form.querySelector<HTMLInputElement>('[data-parent-input]');
  if (parentInput) parentInput.value = commentId;

  const replying = form.querySelector<HTMLElement>('[data-replying]');
  const replyingTo = form.querySelector<HTMLElement>('[data-replying-to]');
  if (replyingTo) replyingTo.textContent = author.trim();
  if (replying) {
    replying.hidden = false;
    replying.classList.remove('is-hidden');
  }

  form.querySelector('textarea')?.focus();
}

function cancelReply(form: HTMLFormElement): void {
  const parentInput = form.querySelector<HTMLInputElement>('[data-parent-input]');
  if (parentInput) parentInput.value = '';
  const replying = form.querySelector<HTMLElement>('[data-replying]');
  if (replying) replying.hidden = true;
}

async function editComment(button: HTMLElement): Promise<void> {
  const host = button.closest<HTMLElement>('[data-comment-id]');
  const id = host?.dataset.commentId ?? '';
  const body = host?.querySelector<HTMLElement>('.comment__body');
  if (!id || !body) return;

  const next = window.prompt('Edit your comment', body.textContent?.trim() ?? '');
  if (next === null) return;

  try {
    const form = new FormData();
    form.set('content', next);
    const data = await api<{ comment: CommentDTOLike }>(`/api/comments/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: form,
    });
    body.innerHTML = data.comment.html;
    toast('Comment updated');
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Could not update comment', 'error');
  }
}

async function deleteComment(button: HTMLElement): Promise<void> {
  const host = button.closest<HTMLElement>('[data-comment-id]');
  const id = host?.dataset.commentId ?? '';
  if (!id || !window.confirm('Delete this comment?')) return;

  try {
    await api(`/api/comments/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const body = host?.querySelector<HTMLElement>('.comment__body');
    if (body) {
      body.textContent = 'This comment was deleted.';
      body.classList.add('is-tombstone');
    }
    host?.querySelector('.comment__actions')?.remove();
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Could not delete comment', 'error');
  }
}

async function loadMoreComments(button: HTMLElement): Promise<void> {
  const section = $<HTMLElement>('[data-comments]');
  const postId = section?.dataset.postId;
  const cursor = button.dataset.cursor;
  if (!postId || !cursor) return;

  try {
    const page = await api<PageLike<CommentDTOLike>>(
      `/api/posts/${encodeURIComponent(postId)}/comments?cursor=${encodeURIComponent(cursor)}`,
    );
    $('[data-comment-list]')?.insertAdjacentHTML('beforeend', page.items.map(renderComment).join(''));
    if (page.nextCursor) button.dataset.cursor = page.nextCursor;
    else button.remove();
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Could not load comments', 'error');
  }
}

// ---------------------------------------------------------------------------
// Character counters
// ---------------------------------------------------------------------------

function updateCharCount(scope: ParentNode): void {
  const counter = scope.querySelector<HTMLElement>('[data-char-count]');
  const field = scope.querySelector<HTMLTextAreaElement>('textarea');
  if (!counter || !field) return;
  const max = Number(counter.dataset.max ?? field.maxLength ?? 0);
  counter.textContent = max ? `${field.value.length} / ${max}` : String(field.value.length);
}

// ---------------------------------------------------------------------------
// Generic form handlers (auth, settings, composer, avatar)
// ---------------------------------------------------------------------------

async function submitAuthForm(form: HTMLFormElement): Promise<void> {
  busy(form, true);
  showFormError(form, null);
  try {
    await api(form.action, { method: 'POST', body: formPayload(form) });
    location.href = form.dataset.redirect || '/';
  } catch (error) {
    showFormError(form, error instanceof Error ? error.message : 'Could not sign in');
    busy(form, false);
  }
}

async function submitSettingsForm(form: HTMLFormElement): Promise<void> {
  const method = (form.dataset.method ?? form.method ?? 'POST').toUpperCase();
  busy(form, true);
  showFormError(form, null);
  try {
    await api(form.action, { method, body: formPayload(form) });
    if (form.dataset.redirect) {
      location.href = form.dataset.redirect;
      return;
    }
    if (form.dataset.reload) {
      location.reload();
      return;
    }
    toast('Saved');
  } catch (error) {
    showFormError(form, error instanceof Error ? error.message : 'Could not save');
  } finally {
    busy(form, false);
  }
}

async function submitComposer(form: HTMLFormElement): Promise<void> {
  busy(form, true);
  showFormError(form, null);

  try {
    const payload = formPayload(form);

    // Images are uploaded first so the post carries media ids, never bytes.
    const files = form.querySelectorAll<HTMLInputElement>('[data-composer-file]');
    const mediaIds: string[] = [];
    for (const input of Array.from(files)) {
      for (const file of Array.from(input.files ?? [])) {
        const upload = new FormData();
        upload.set('file', file);
        upload.set('usage', 'post');
        const media = await api<{ media: { id: string } }>('/api/media/upload', {
          method: 'POST',
          body: upload,
        });
        mediaIds.push(media.media.id);
      }
      payload.delete(input.name);
    }
    if (mediaIds.length) payload.set('mediaIds', mediaIds.join(','));

    const data = await api<{ post: { slug: string } }>('/api/posts', {
      method: 'POST',
      body: payload,
    });

    if (form.dataset.redirectToPost) location.href = `/post/${data.post.slug}`;
    else location.reload();
  } catch (error) {
    showFormError(form, error instanceof Error ? error.message : 'Could not publish');
    busy(form, false);
  }
}

async function submitAvatarForm(form: HTMLFormElement): Promise<void> {
  const input = form.querySelector<HTMLInputElement>('input[type="file"]');
  const file = input?.files?.[0];
  if (!file) {
    showFormError(form, 'Choose an image first');
    return;
  }

  busy(form, true);
  try {
    const upload = new FormData();
    upload.set('file', file);
    upload.set('usage', 'avatar');
    await api('/api/media/upload', { method: 'POST', body: upload });
    location.reload();
  } catch (error) {
    showFormError(form, error instanceof Error ? error.message : 'Could not upload');
    busy(form, false);
  }
}

// ---------------------------------------------------------------------------
// Notifications badge
// ---------------------------------------------------------------------------

async function refreshUnreadBadge(): Promise<void> {
  if (!boot.user) return;
  const badge = $<HTMLElement>('[data-unread-badge]');
  if (!badge) return;

  try {
    const data = await api<{ count: number }>('/api/notifications/unread-count');
    const count = Number(data.count ?? 0);
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.hidden = count === 0;
    badge.classList.toggle('is-hidden', count === 0);
  } catch {
    /* a failed badge refresh is never worth bothering the user about */
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function initDelegatedClicks(): void {
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const matchers: [string, (el: HTMLElement) => void | Promise<void>][] = [
      ['[data-reaction]', handleReaction],
      ['[data-comment-react]', handleReaction],
      ['[data-bookmark]', handleBookmark],
      ['[data-share]', handleShare],
      ['[data-delete-post]', handleDeletePost],
      ['[data-report]', handleReport],
      ['[data-reply-to]', startReply],
      ['[data-edit-comment]', editComment],
      ['[data-delete-comment]', deleteComment],
      ['[data-load-more-comments]', loadMoreComments],
      ['[data-load-more]', loadMoreFeed],
    ];

    for (const [selector, handler] of matchers) {
      const el = target.closest<HTMLElement>(selector);
      if (el) {
        event.preventDefault();
        void handler(el);
        return;
      }
    }

    const cancel = target.closest<HTMLElement>('[data-cancel-reply]');
    if (cancel) {
      event.preventDefault();
      const form = cancel.closest<HTMLFormElement>('form');
      if (form) cancelReply(form);
    }
  });
}

function initForms(): void {
  document.addEventListener('submit', (event) => {
    const form = event.target as HTMLFormElement | null;
    if (!(form instanceof HTMLFormElement)) return;

    const handlers: [string, (f: HTMLFormElement) => Promise<void>][] = [
      ['[data-composer]', submitComposer],
      ['[data-avatar-form]', submitAvatarForm],
      ['[data-comment-form]', submitComment],
      ['[data-follow-form]', handleFollowForm],
      ['[data-auth-form]', submitAuthForm],
      ['[data-settings-form]', submitSettingsForm],
    ];

    for (const [selector, handler] of handlers) {
      if (form.matches(selector)) {
        event.preventDefault();
        void handler(form);
        return;
      }
    }
  });

  // Live character counters.
  document.addEventListener('input', (event) => {
    const field = event.target as HTMLElement | null;
    if (field instanceof HTMLTextAreaElement) {
      const scope = field.closest('form') ?? document;
      updateCharCount(scope);
    }
  });

  for (const form of $$<HTMLFormElement>('form')) updateCharCount(form);

  // Show selected filenames in the composer.
  document.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement | null;
    if (!input?.matches('[data-composer-file]')) return;
    const list = $('[data-composer-attachments]');
    if (!list) return;
    list.textContent = '';
    for (const file of Array.from(input.files ?? [])) {
      const li = document.createElement('li');
      li.textContent = `${file.name} (${Math.round(file.size / 1024)} KB)`;
      list.appendChild(li);
    }
  });
}

function initNotifications(): void {
  void refreshUnreadBadge();
  // A slow poll is enough for a badge and costs one tiny request per minute.
  window.setInterval(() => void refreshUnreadBadge(), 60_000);

  document.addEventListener('click', (event) => {
    const item = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-notification-id]');
    const id = item?.dataset.notificationId;
    if (!id || !item?.classList.contains('notif--unread')) return;

    const body = new FormData();
    body.set('ids', id);
    void api('/api/notifications/read', { method: 'POST', body })
      .then(() => {
        item.classList.remove('notif--unread');
        item.querySelector('[data-notif-dot]')?.remove();
        void refreshUnreadBadge();
      })
      .catch(() => undefined);
  });
}

function init(): void {
  initTheme();
  initDelegatedClicks();
  initForms();
  initNotifications();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

export {};
