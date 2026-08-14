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
    __AES__?: Bootstrap;
    __ANK__?: Bootstrap;
  }
}

const boot: Bootstrap =
  window.__AES__ ?? window.__ANK__ ?? { user: null, csrfToken: null, origin: location.origin };

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
  document.documentElement.classList.toggle('theme-dark', dark);
  document.documentElement.classList.toggle('theme-light', !dark);
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

async function handlePin(button: HTMLElement): Promise<void> {
  const postId = button.dataset.postId ?? '';
  if (!postId) return;
  try {
    const data = await api<{ pinned: boolean }>(`/api/posts/${encodeURIComponent(postId)}/pin`, {
      method: 'POST',
    });
    button.classList.toggle('is-active', data.pinned);
    button.setAttribute('aria-pressed', data.pinned ? 'true' : 'false');
    button.textContent = data.pinned ? 'Unpin' : 'Pin';
    const card = button.closest<HTMLElement>('[data-post-card]');
    card?.classList.toggle('postcard--pinned', data.pinned);
    const feed = card?.closest<HTMLElement>('[data-feed]');
    if (data.pinned && card && feed) feed.prepend(card);
    toast(data.pinned ? 'Pinned to the top' : 'Unpinned');
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Could not pin', 'error');
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
function isFresh(createdAt: number): boolean {
  return Date.now() / 1000 - createdAt < 2 * 60 * 60;
}

function renderPostCard(post: PostDTOLike): string {
  const author = post.author;
  const fresh = isFresh(post.createdAt);
  return `<article class="postcard${fresh ? ' postcard--fresh' : ''}" data-post-card data-post-id="${escapeHtml(post.id)}" data-created="${post.createdAt}">
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
    <div class="postcard__excerpt" data-clamp>
      <div class="prose prose--sm prose--clamp" data-clamp-body>${post.html}</div>
      <a class="seemore" href="/post/${encodeURIComponent(post.slug)}" data-see-more>XEM THÊM >>></a>
    </div>
    <p class="postcard__meta"><a href="/post/${encodeURIComponent(post.slug)}">${post.reactionCount} reactions · ${post.commentCount} comments</a></p>
  </article>`;
}

function markClamped(scope: ParentNode = document): void {
  for (const wrap of $$<HTMLElement>('[data-clamp]', scope)) {
    const body = wrap.querySelector<HTMLElement>('[data-clamp-body]');
    if (!body) continue;
    const overflowing = body.scrollHeight > body.clientHeight + 8;
    wrap.classList.toggle('is-short', !overflowing);
  }
}

function handleSeeMore(el: HTMLElement, event: Event): void {
  const wrap = el.closest<HTMLElement>('[data-clamp]');
  if (!wrap) return;
  if (wrap.classList.contains('is-expanded')) {
    wrap.classList.remove('is-expanded');
    el.textContent = 'XEM THÊM >>>';
    if (el instanceof HTMLAnchorElement) el.setAttribute('href', el.dataset.href || el.href);
    return;
  }
  event.preventDefault();
  if (el instanceof HTMLAnchorElement && !el.dataset.href) el.dataset.href = el.getAttribute('href') || '';
  wrap.classList.add('is-expanded');
  el.textContent = 'THU GỌN <<<';
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
      const parent = $<HTMLElement>(`[data-comment-id="${CSS.escape(parentId)}"]`);
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

    const data = await api<{ post: PostDTOLike & { slug: string } }>('/api/posts', {
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
// Public status dashboard
// ---------------------------------------------------------------------------

type LiveHealthState = 'ok' | 'error' | 'missing';

interface LiveHealthReport {
  status: 'ok';
  readiness: 'ready' | 'degraded' | 'not_ready';
  checks: {
    database: 'ok' | 'error';
    storage: LiveHealthState;
    schema: LiveHealthState;
  };
  storageError?: string;
  schema: { ready: boolean; applied: number; pending: number };
  latencyMs: { database: number; storage: number; schema: number; total: number };
  timestamp: string;
}

function liveStatusLabel(state: LiveHealthState, key: 'edge' | 'database' | 'storage' | 'schema'): string {
  if (state === 'ok') return 'Operational';
  if (state === 'missing') return key === 'storage' ? 'Not configured' : 'Migration required';
  return 'Unavailable';
}

function updateStatusComponent(
  key: 'edge' | 'database' | 'storage' | 'schema',
  state: LiveHealthState,
  latency: number,
  report: LiveHealthReport,
): void {
  const row = $<HTMLElement>(`[data-status-component="${key}"]`);
  if (!row) return;

  const operational = state === 'ok';
  const missing = state === 'missing';
  row.classList.toggle('status-component--operational', operational);
  row.classList.toggle('status-component--outage', !operational && !missing);

  const badge = $<HTMLElement>('[data-status-badge]', row);
  if (badge) {
    badge.textContent = liveStatusLabel(state, key);
    badge.classList.toggle('status-badge--operational', operational);
    badge.classList.toggle('status-badge--outage', !operational && !missing);
    badge.classList.toggle('status-badge--missing', missing);
  }

  const latencyNode = $<HTMLElement>('[data-status-latency]', row);
  if (latencyNode) latencyNode.textContent = `${Math.max(0, Math.round(latency))} ms`;

  const description = $<HTMLElement>('[data-status-description]', row);
  if (!description) return;
  if (key === 'edge') {
    description.textContent = 'The status page and Worker are responding.';
  } else if (key === 'database') {
    description.textContent = operational
      ? 'Queries are responding normally.'
      : 'Posts, accounts and other data may be unavailable.';
  } else if (key === 'storage') {
    description.textContent = operational
      ? 'Uploads and media delivery are available.'
      : state === 'missing'
        ? report.storageError
          ? `Object storage is not configured (${report.storageError}).`
          : 'Object storage is not configured — uploads and media delivery are disabled.'
        : report.storageError
          ? `Uploads and media delivery are unavailable (${report.storageError}).`
          : 'Uploads and media delivery may be unavailable.';
  } else if (state === 'ok') {
    const total = report.schema.applied + report.schema.pending;
    description.textContent = `${report.schema.applied} of ${total} migrations applied.`;
  } else if (state === 'missing') {
    description.textContent = `${report.schema.pending} database migration${report.schema.pending === 1 ? '' : 's'} pending.`;
  } else {
    description.textContent = 'The application schema is incomplete or unavailable.';
  }
}

function updateStatusDashboard(report: LiveHealthReport): void {
  const page = $<HTMLElement>('[data-status-page]');
  const overall = $<HTMLElement>('[data-status-overall]');
  if (!page || !overall) return;

  const state = report.readiness === 'ready' ? 'operational' : report.readiness === 'degraded' ? 'degraded' : 'outage';
  page.dataset.overall = state;
  for (const candidate of ['operational', 'degraded', 'outage']) {
    overall.classList.toggle(`status-overall--${candidate}`, candidate === state);
  }

  const title = $<HTMLElement>('[data-status-overall-title]', overall);
  const body = $<HTMLElement>('[data-status-overall-body]', overall);
  if (state === 'operational') {
    if (title) title.textContent = 'All systems operational';
    if (body) body.textContent = 'AES is running normally.';
  } else if (state === 'degraded') {
    if (title) title.textContent = 'Degraded service';
    if (body) body.textContent = 'The site is online, but some features may be temporarily unavailable.';
  } else {
    if (title) title.textContent = 'Major service outage';
    if (body) body.textContent = 'One or more core systems are unavailable. We are investigating.';
  }

  updateStatusComponent('edge', 'ok', report.latencyMs.total, report);
  updateStatusComponent('database', report.checks.database, report.latencyMs.database, report);
  updateStatusComponent('storage', report.checks.storage, report.latencyMs.storage, report);
  updateStatusComponent('schema', report.checks.schema, report.latencyMs.schema, report);

  const checked = $<HTMLTimeElement>('[data-status-checked]');
  if (checked) {
    checked.dateTime = report.timestamp;
    const parsed = new Date(report.timestamp);
    checked.textContent = Number.isNaN(parsed.getTime())
      ? report.timestamp
      : `${parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })}`;
  }
}

async function refreshStatusDashboard(): Promise<void> {
  const button = $<HTMLButtonElement>('[data-status-refresh]');
  if (button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  }

  try {
    const response = await fetch('/health', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('Health endpoint unavailable');
    updateStatusDashboard((await response.json()) as LiveHealthReport);
  } catch {
    const overall = $<HTMLElement>('[data-status-overall]');
    if (overall) {
      overall.classList.remove('status-overall--operational', 'status-overall--degraded');
      overall.classList.add('status-overall--outage');
      const title = $<HTMLElement>('[data-status-overall-title]', overall);
      const body = $<HTMLElement>('[data-status-overall-body]', overall);
      if (title) title.textContent = 'Unable to refresh status';
      if (body) body.textContent = 'The live health endpoint did not respond. This page may be out of date.';
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }
}

function initStatusDashboard(): void {
  if (!$('[data-status-page]')) return;
  const button = $<HTMLButtonElement>('[data-status-refresh]');
  button?.addEventListener('click', () => void refreshStatusDashboard());
  window.setInterval(() => {
    if (!document.hidden) void refreshStatusDashboard();
  }, 60_000);
}

// ---------------------------------------------------------------------------
// Notifications badge
// ---------------------------------------------------------------------------

/** Paint one count onto every badge bound to it (header bell + mobile bar). */
function paintBadges(selector: string, count: number, cap = 99): void {
  const label = count > cap ? `${cap}+` : String(count);
  for (const badge of $$<HTMLElement>(selector)) {
    badge.textContent = label;
    badge.hidden = count === 0;
    badge.classList.toggle('is-hidden', count === 0);
  }
}

async function refreshUnreadBadge(): Promise<void> {
  if (!boot.user) return;
  if (!$('[data-unread-badge]')) return;

  try {
    const data = await api<{ count: number }>('/api/notifications/unread-count');
    paintBadges('[data-unread-badge]', Number(data.count ?? 0));
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

    const retry = target.closest('[data-retry]');
    if (retry) {
      event.preventDefault();
      location.reload();
      return;
    }

    const matchers: [string, (el: HTMLElement) => void | Promise<void>][] = [
      ['[data-reaction]', handleReaction],
      ['[data-comment-react]', handleReaction],
      ['[data-pin]', handlePin],
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

    const seeMore = target.closest<HTMLElement>('[data-see-more]');
    if (seeMore) {
      handleSeeMore(seeMore, event);
      return;
    }

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
      ['[data-new-conversation-form]', submitNewConversation],
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

// ---------------------------------------------------------------------------
// Popovers: the notification panel and the account menu
// ---------------------------------------------------------------------------

interface NotificationLike {
  id: string;
  text: string;
  href: string;
  createdAt: number;
  readAt: number | null;
  type: string;
  actor: { username: string; displayName: string; avatarMediaId: string | null } | null;
}

const NOTIF_ICONS: Record<string, string> = {
  FOLLOW: '\u{1F464}',
  LIKE: '\u2764\uFE0F',
  COMMENT: '\u{1F4AC}',
  REPLY: '\u21A9\uFE0F',
  MENTION: '@',
  SYSTEM: '\u{1F514}',
  MODERATION: '\u{1F6E1}\uFE0F',
};

/** "3m", "5h", "2d" — the panel is narrow, so the stamp has to be too. */
function shortAgo(seconds: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (delta < 60) return 'now';
  if (delta < 3_600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86_400) return `${Math.floor(delta / 3_600)}h`;
  if (delta < 604_800) return `${Math.floor(delta / 86_400)}d`;
  return new Date(seconds * 1000).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/**
 * One row of the panel.
 *
 * `text` and `href` are computed by the server (the same helpers the SSR page
 * uses), and everything interpolated here is escaped — the API never hands the
 * client pre-rendered markup for notifications.
 */
function renderNotifRow(item: NotificationLike): string {
  const unread = !item.readAt;
  const avatar = item.actor?.avatarMediaId
    ? `<img class="notifpop__avatar" src="/media/${encodeURIComponent(
        item.actor.avatarMediaId,
      )}?v=thumb" alt="" width="32" height="32" loading="lazy" decoding="async">`
    : `<span class="notifpop__icon" aria-hidden="true">${escapeHtml(
        NOTIF_ICONS[item.type] ?? '\u{1F514}',
      )}</span>`;

  return `<li class="notifpop__item ${unread ? 'is-unread' : ''}" data-notif-item data-id="${escapeHtml(
    item.id,
  )}">
    <a class="notifpop__link" href="${escapeHtml(item.href)}">
      ${avatar}
      <span class="notifpop__body">
        <span class="notifpop__text">${escapeHtml(item.text)}</span>
        <span class="notifpop__time muted">${escapeHtml(shortAgo(item.createdAt))}</span>
      </span>
    </a>
    <button class="notifpop__mark" type="button" data-notif-mark="${escapeHtml(item.id)}"
            title="${unread ? 'Mark as read' : 'Read'}"
            aria-label="${unread ? 'Mark this notification as read' : 'Already read'}"
            ${unread ? '' : 'disabled'}>\u2713</button>
  </li>`;
}

/**
 * The notification dropdown.
 *
 * Loads ten at a time and stops at twenty, which is the point of the panel: it
 * is a glance, not an archive. "Show all" goes to the full page, where the
 * existing cursor pagination takes over.
 */
function initNotificationPanel(): void {
  const host = $<HTMLElement>('[data-notif-menu]');
  if (!host || !boot.user) return;

  const trigger = $<HTMLElement>('[data-notif-toggle]', host);
  const panel = $<HTMLElement>('[data-notif-panel]', host);
  const list = $<HTMLElement>('[data-notif-list]', host);
  const scroller = $<HTMLElement>('[data-notif-scroll]', host);
  const state = $<HTMLElement>('[data-notif-state]', host);
  if (!trigger || !panel || !list || !scroller) return;

  const PAGE_SIZE = 10;
  const MAX_ITEMS = 20;
  let cursor: string | null = null;
  let loading = false;
  let exhausted = false;
  let loadedAny = false;

  const setState = (text: string) => {
    if (!state) return;
    state.textContent = text;
    state.hidden = !text;
  };

  const load = async () => {
    if (loading || exhausted) return;
    if (list.children.length >= MAX_ITEMS) return;
    loading = true;
    setState(loadedAny ? 'Loading more…' : 'Loading…');

    try {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor) query.set('cursor', cursor);
      const page = await api<{ items: NotificationLike[]; nextCursor: string | null; hasMore: boolean }>(
        `/api/notifications?${query.toString()}`,
      );

      // Never grow past the cap, even if the server returns a full page.
      const room = MAX_ITEMS - list.children.length;
      const items = page.items.slice(0, room);
      list.insertAdjacentHTML('beforeend', items.map(renderNotifRow).join(''));

      cursor = page.nextCursor;
      loadedAny = true;
      exhausted = !page.hasMore || !page.nextCursor;

      if (!list.children.length) setState('Nothing here yet.');
      else if (list.children.length >= MAX_ITEMS) setState('');
      else setState(exhausted ? '' : 'Scroll for more');
    } catch (error) {
      setState(error instanceof Error ? error.message : 'Could not load notifications.');
    } finally {
      loading = false;
    }
  };

  const markRead = async (ids: string[]) => {
    if (!ids.length) return;
    const body = new FormData();
    for (const id of ids) body.append('ids', id);
    await api('/api/notifications/read', { method: 'POST', body });
    for (const id of ids) {
      const row = list.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
      row?.classList.remove('is-unread');
      const button = row?.querySelector<HTMLButtonElement>('[data-notif-mark]');
      if (button) button.disabled = true;
    }
    void refreshUnreadBadge();
  };

  const close = () => {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  };

  const open = () => {
    // One panel at a time.
    for (const other of $$<HTMLElement>('.popover__panel')) {
      if (other !== panel) other.hidden = true;
    }
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    if (!loadedAny) void load();
  };

  trigger.addEventListener('click', (event) => {
    // Without JavaScript this is a link to /notifications; with it, it toggles.
    event.preventDefault();
    if (panel.hidden) open();
    else close();
  });

  // Each scroll to the bottom pulls the next ten.
  scroller.addEventListener('scroll', () => {
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 40) void load();
  });

  panel.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;

    const mark = target?.closest<HTMLElement>('[data-notif-mark]');
    if (mark) {
      event.preventDefault();
      const id = mark.dataset.notifMark;
      if (id) void markRead([id]).catch(() => toast('Could not mark as read', 'error'));
      return;
    }

    if (target?.closest('[data-notif-read-all]')) {
      event.preventDefault();
      void api('/api/notifications/read-all', { method: 'POST' })
        .then(() => {
          for (const row of $$<HTMLElement>('[data-notif-item]', list)) {
            row.classList.remove('is-unread');
            const button = row.querySelector<HTMLButtonElement>('[data-notif-mark]');
            if (button) button.disabled = true;
          }
          void refreshUnreadBadge();
        })
        .catch(() => toast('Could not mark everything read', 'error'));
      return;
    }

    // Following a notification implies reading it.
    const link = target?.closest<HTMLElement>('.notifpop__link');
    const row = link?.closest<HTMLElement>('[data-notif-item]');
    if (row?.classList.contains('is-unread') && row.dataset.id) {
      void markRead([row.dataset.id]).catch(() => undefined);
    }
  });

  document.addEventListener('click', (event) => {
    if (!panel.hidden && !host.contains(event.target as Node)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) {
      close();
      trigger.focus();
    }
  });
}

/** The avatar menu: profile, bookmarks, settings, theme, sign out. */
function initAccountMenu(): void {
  const host = $<HTMLElement>('[data-account-menu]');
  if (!host) return;
  const trigger = $<HTMLElement>('[data-account-toggle]', host);
  const panel = $<HTMLElement>('[data-account-panel]', host);
  if (!trigger || !panel) return;

  const close = () => {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  };

  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    const opening = panel.hidden;
    for (const other of $$<HTMLElement>('.popover__panel')) other.hidden = true;
    panel.hidden = !opening;
    trigger.setAttribute('aria-expanded', opening ? 'true' : 'false');
  });

  document.addEventListener('click', (event) => {
    if (!panel.hidden && !host.contains(event.target as Node)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) {
      close();
      trigger.focus();
    }
  });
}

function newestSeen(feed: HTMLElement): number {
  const attr = Number(feed.dataset.newest ?? 0);
  if (attr > 0) return attr;
  const first = feed.querySelector<HTMLElement>('[data-created]');
  return Number(first?.dataset.created ?? 0);
}

function initLiveFeed(): void {
  const feed = $<HTMLElement>('[data-feed]');
  const button = $<HTMLButtonElement>('[data-new-posts]');
  if (!feed || !button) return;

  const endpoint = feed.dataset.endpoint ?? '/api/posts?sort=latest';
  if (!endpoint.includes('sort=latest') && !endpoint.includes('sort=following')) return;

  let pending: PostDTOLike[] = [];

  const showPending = () => {
    if (!pending.length) {
      button.hidden = true;
      button.classList.add('is-hidden');
      return;
    }
    button.hidden = false;
    button.classList.remove('is-hidden');
    button.textContent = pending.length === 1 ? '1 new post' : `${pending.length} new posts`;
  };

  const poll = async () => {
    if (document.hidden) return;
    const since = newestSeen(feed);
    if (!since) return;
    try {
      const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}since=${since}&limit=10`;
      const page = await api<PageLike<PostDTOLike>>(url);
      const existing = new Set(
        $$<HTMLElement>('[data-post-id]', feed).map((el) => el.dataset.postId ?? ''),
      );
      const fresh = page.items.filter((item) => !existing.has(item.id));
      if (!fresh.length) return;
      const seen = new Set(pending.map((p) => p.id));
      for (const item of fresh) {
        if (!seen.has(item.id)) pending.push(item);
      }
      showPending();
    } catch {
      /* polling is best-effort */
    }
  };

  button.addEventListener('click', () => {
    if (!pending.length) return;
    const html = pending
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(renderPostCard)
      .join('');
    feed.insertAdjacentHTML('afterbegin', html);
    const top = pending.reduce((max, p) => Math.max(max, p.createdAt), newestSeen(feed));
    feed.dataset.newest = String(top);
    pending = [];
    showPending();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  window.setInterval(() => void poll(), 25_000);
  void poll();
}

// ---------------------------------------------------------------------------
// Direct messages
// ---------------------------------------------------------------------------

interface MessageLike {
  id: string;
  conversationId: string;
  content: string;
  kind?: 'text' | 'image' | 'audio' | 'sticker';
  mediaUrl?: string | null;
  durationMs?: number;
  createdAt: number;
  mine: boolean;
  sender: { id: string; username: string; displayName: string; avatarMediaId: string | null };
}

interface MessagesBoot {
  conversationId: string | null;
  latestCursor?: string | null;
  socket?: boolean;
}

/** "0:07" from a millisecond duration — mirrors the server-side helper. */
function clockDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The inside of a bubble, which depends on what was sent. Mirrors the SSR. */
function renderBubbleContent(message: MessageLike): string {
  const text = escapeHtml(message.content).replace(/\r?\n/g, '<br>');

  if (message.kind === 'sticker') {
    return `<div class="bubble__sticker" role="img" aria-label="Sticker">${text}</div>`;
  }

  if (message.kind === 'image' && message.mediaUrl) {
    const caption =
      message.content && message.content !== 'Photo' ? `<div class="bubble__text">${text}</div>` : '';
    return `<a class="bubble__photo" href="${escapeHtml(message.mediaUrl)}" data-lightbox>
      <img src="${escapeHtml(message.mediaUrl)}" alt="${escapeHtml(
        message.content,
      )}" loading="lazy" decoding="async">
    </a>${caption}`;
  }

  if (message.kind === 'audio' && message.mediaUrl) {
    const caption =
      message.content && message.content !== 'Voice message'
        ? `<div class="bubble__text">${text}</div>`
        : '';
    const length = message.durationMs
      ? `<span class="bubble__duration muted">${escapeHtml(clockDuration(message.durationMs))}</span>`
      : '';
    return `<div class="bubble__voice">
      <audio class="bubble__audio" src="${escapeHtml(message.mediaUrl)}" controls preload="none"></audio>
      ${length}
    </div>${caption}`;
  }

  return `<div class="bubble__text">${text}</div>`;
}

/** Server-rendered bubble, reproduced closely enough that the two interleave. */
function renderBubble(message: MessageLike, pending = false): string {
  const avatar = message.mine
    ? ''
    : message.sender.avatarMediaId
      ? `<span class="avatar avatar--sm"><img src="/media/${encodeURIComponent(
          message.sender.avatarMediaId,
        )}?v=thumb" alt="" width="32" height="32" loading="lazy" decoding="async"></span>`
      : `<span class="avatar avatar--sm"><span class="avatar__fallback" aria-hidden="true">${escapeHtml(
          (message.sender.displayName || message.sender.username).slice(0, 2).toUpperCase(),
        )}</span></span>`;

  const stamp = new Date(message.createdAt * 1000);

  return `<li class="bubble ${message.mine ? 'bubble--mine' : ''} ${
    message.kind === 'sticker' ? 'bubble--sticker' : ''
  } ${pending ? 'bubble--pending' : ''}" data-message-id="${escapeHtml(message.id)}">
    ${avatar}
    <div class="bubble__body">
      ${renderBubbleContent(message)}
      <time class="bubble__time" datetime="${stamp.toISOString()}">${
        pending ? 'Sending…' : stamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }</time>
    </div>
  </li>`;
}

async function refreshMessagesBadge(): Promise<void> {
  if (!boot.user) return;
  if (!$('[data-messages-badge]')) return;
  try {
    const data = await api<{ count: number }>('/api/messages/unread-count');
    paintBadges('[data-messages-badge]', Number(data.count ?? 0), 9);
  } catch {
    /* best effort */
  }
}

interface InboxPerson {
  id: string;
  username: string;
  displayName: string;
  avatarMediaId: string | null;
}

interface InboxConversation {
  id: string;
  peer: InboxPerson;
  lastMessage: { content: string; createdAt: number; mine: boolean } | null;
  unreadCount: number;
}

function avatarMarkup(person: InboxPerson): string {
  if (person.avatarMediaId) {
    return `<span class="avatar avatar--md"><img src="/media/${encodeURIComponent(
      person.avatarMediaId,
    )}?v=thumb" alt="" width="40" height="40" loading="lazy" decoding="async"></span>`;
  }
  return `<span class="avatar avatar--md"><span class="avatar__fallback" aria-hidden="true">${escapeHtml(
    (person.displayName || person.username).slice(0, 2).toUpperCase(),
  )}</span></span>`;
}

/** One inbox row, matching the server-rendered markup. */
function renderConversationRow(item: InboxConversation, activeId: string): string {
  const last = item.lastMessage;
  const preview = last ? `${last.mine ? 'You: ' : ''}${last.content}` : `@${item.peer.username}`;
  return `<li class="convo ${item.id === activeId ? 'is-active' : ''} ${
    item.unreadCount ? 'convo--unread' : ''
  }" data-conversation-row="${escapeHtml(item.id)}">
    <a class="convo__link" href="/messages/${encodeURIComponent(item.id)}">
      ${avatarMarkup(item.peer)}
      <span class="convo__body">
        <span class="convo__top"><span class="convo__name">${escapeHtml(item.peer.displayName)}</span>
          ${last ? `<span class="convo__time muted">${escapeHtml(shortAgo(last.createdAt))}</span>` : ''}
        </span>
        <span class="convo__preview muted">${escapeHtml(preview)}</span>
      </span>
      ${
        item.unreadCount
          ? `<span class="convo__badge" aria-label="${item.unreadCount} unread">${item.unreadCount}</span>`
          : ''
      }
    </a>
  </li>`;
}

/** A person the viewer has not messaged yet; submitting opens the chat. */
function renderPersonRow(person: InboxPerson, token: string): string {
  return `<li class="convo convo--new">
    <form class="convo__link" method="post" action="/api/messages" data-open-conversation>
      <input type="hidden" name="_csrf" value="${escapeHtml(token)}">
      <input type="hidden" name="username" value="${escapeHtml(person.username)}">
      ${avatarMarkup(person)}
      <span class="convo__body">
        <span class="convo__top"><span class="convo__name">${escapeHtml(person.displayName)}</span></span>
        <span class="convo__preview muted">@${escapeHtml(person.username)}</span>
      </span>
      <button class="btn btn--small btn--ghost" type="submit">Message</button>
    </form>
  </li>`;
}

/**
 * Live inbox search.
 *
 * Typing one character is enough: matching conversations are filtered locally
 * for an instant response, and a debounced request to the server then replaces
 * the list with the authoritative result — which also surfaces people the
 * viewer has never messaged, who by definition are not in the local list.
 */
function initInboxSearch(): void {
  const form = $<HTMLFormElement>('[data-inbox-search]');
  const input = $<HTMLInputElement>('[data-inbox-query]');
  const results = $<HTMLElement>('[data-inbox-results]');
  if (!form || !input || !results) return;

  const activeId = $<HTMLElement>('[data-thread]')?.dataset.conversation ?? '';
  let timer = 0;
  let sequence = 0;

  /** Instant, offline narrowing of the rows already on screen. */
  const filterLocally = (term: string) => {
    const needle = term.trim().toLowerCase();
    for (const row of $$<HTMLElement>('[data-conversation-row]', results)) {
      const haystack = row.dataset.searchName ?? row.textContent?.toLowerCase() ?? '';
      row.hidden = needle !== '' && !haystack.includes(needle);
    }
  };

  const search = async (term: string) => {
    const ticket = ++sequence;
    try {
      const data = await api<{ items: InboxConversation[]; people: InboxPerson[] }>(
        `/api/messages?q=${encodeURIComponent(term)}`,
      );
      // A slower earlier request must never overwrite a newer result.
      if (ticket !== sequence) return;

      const token = csrfToken();
      const conversations = data.items ?? [];
      const people = data.people ?? [];

      const parts: string[] = [];
      if (conversations.length) {
        parts.push(
          `<ul class="convolist" data-conversation-list>${conversations
            .map((item) => renderConversationRow(item, activeId))
            .join('')}</ul>`,
        );
      } else if (term.trim()) {
        parts.push(
          `<p class="messenger__noresults muted">No conversation matches \u201C${escapeHtml(
            term,
          )}\u201D.</p>`,
        );
      }
      if (people.length) {
        parts.push(
          `<p class="messenger__grouplabel muted">People you haven't messaged</p>
           <ul class="convolist" data-people-list>${people
             .map((person) => renderPersonRow(person, token))
             .join('')}</ul>`,
        );
      }
      if (!parts.length) {
        parts.push('<p class="messenger__noresults muted">Nobody found. Try another name.</p>');
      }
      results.innerHTML = parts.join('');
    } catch {
      // Leave the locally filtered list in place — it is still useful.
    }
  };

  input.addEventListener('input', () => {
    const term = input.value;
    filterLocally(term);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void search(term), 180);
  });

  // With JavaScript the search is live, so a full navigation is redundant.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    window.clearTimeout(timer);
    void search(input.value);
  });
}

/** Reveal the "start a conversation" form and the inbox list interactions. */
function initConversationList(): void {
  const toggle = $<HTMLButtonElement>('[data-new-conversation]');
  const form = $<HTMLFormElement>('[data-new-conversation-form]');
  if (toggle && form) {
    toggle.addEventListener('click', () => {
      const open = form.hidden;
      form.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) form.querySelector<HTMLInputElement>('input[name="username"]')?.focus();
    });
  }
  initInboxSearch();
}

async function submitNewConversation(form: HTMLFormElement): Promise<void> {
  showFormError(form, null);
  busy(form, true);
  try {
    const data = await api<{ conversationId: string }>('/api/messages', {
      method: 'POST',
      body: formPayload(form),
    });
    location.href = `/messages/${encodeURIComponent(data.conversationId)}`;
  } catch (error) {
    showFormError(form, error instanceof Error ? error.message : 'Could not start the conversation.');
    busy(form, false);
  }
}

/**
 * Live thread.
 *
 * Delivery is a WebSocket to the conversation's Durable Object, but nothing
 * depends on it: sending is a normal HTTP POST, and a `?after=` poll runs
 * whenever the socket is closed (or was never available, e.g. no DO binding),
 * so an offline tab still catches up on focus.
 */
function initThread(): void {
  const thread = $<HTMLElement>('[data-thread]');
  if (!thread) return;

  const conversationId = thread.dataset.conversation ?? '';
  const list = $<HTMLElement>('[data-thread-messages]', thread);
  const scroller = $<HTMLElement>('[data-thread-scroll]', thread);
  const form = $<HTMLFormElement>('[data-message-form]', thread);
  const input = form?.querySelector<HTMLTextAreaElement>('textarea[name="content"]') ?? null;
  const typingLine = $<HTMLElement>('[data-thread-typing]', thread);
  const status = $<HTMLElement>('[data-thread-status]', thread);
  if (!conversationId || !list || !scroller) return;

  const messagesBoot = (boot.messages ?? {}) as MessagesBoot;
  const seen = new Set<string>($$<HTMLElement>('[data-message-id]', list).map((el) => el.dataset.messageId ?? ''));
  let latestCursor: string | null = thread.dataset.latestCursor || messagesBoot.latestCursor || null;
  let socket: WebSocket | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer = 0;
  let typingTimer = 0;
  let lastTypingSent = 0;
  let closedForGood = false;

  const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  const toBottom = () => {
    scroller.scrollTop = scroller.scrollHeight;
  };

  const setStatus = (text: string) => {
    if (status) status.textContent = text;
  };

  const append = (message: MessageLike): boolean => {
    if (seen.has(message.id)) return false;
    // A message we just sent is already on screen as an optimistic bubble.
    const optimistic = list.querySelector<HTMLElement>(`[data-pending-for="${CSS.escape(message.id)}"]`);
    seen.add(message.id);
    const stick = atBottom();
    if (optimistic) {
      optimistic.outerHTML = renderBubble(message);
    } else {
      list.insertAdjacentHTML('beforeend', renderBubble(message));
    }
    if (stick) toBottom();
    return true;
  };

  const markRead = () => {
    void api(`/api/messages/${encodeURIComponent(conversationId)}/read`, { method: 'POST' })
      .then(() => refreshMessagesBadge())
      .catch(() => undefined);
  };

  // --- catch-up poll --------------------------------------------------------

  let polling = false;
  const catchUp = async () => {
    if (polling || !latestCursor) return;
    polling = true;
    try {
      const data = await api<{ items: MessageLike[]; latestCursor: string | null }>(
        `/api/messages/${encodeURIComponent(conversationId)}?after=${encodeURIComponent(latestCursor)}`,
      );
      let added = false;
      for (const message of data.items) added = append(message) || added;
      if (data.latestCursor) latestCursor = data.latestCursor;
      if (added && !document.hidden) markRead();
    } catch {
      /* the next tick tries again */
    } finally {
      polling = false;
    }
  };

  // --- socket ---------------------------------------------------------------

  const connect = () => {
    if (closedForGood || messagesBoot.socket === false) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${scheme}//${location.host}/api/community/conversations/${encodeURIComponent(
      conversationId,
    )}/socket`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return;
    }
    socket = ws;

    ws.addEventListener('open', () => {
      reconnectAttempt = 0;
      setStatus('');
      // Anything that landed while the socket was down.
      void catchUp();
    });

    ws.addEventListener('message', (event) => {
      let frame: { type?: string; message?: MessageLike; username?: string; userId?: string };
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      switch (frame.type) {
        case 'message': {
          const message = frame.message;
          if (!message || message.conversationId !== conversationId) return;
          if (append(message) && !message.mine) {
            if (document.hidden) void refreshMessagesBadge();
            else markRead();
          }
          break;
        }
        case 'typing': {
          if (!typingLine || frame.userId === boot.user?.id) return;
          typingLine.textContent = `${frame.username ?? 'Someone'} is typing…`;
          typingLine.hidden = false;
          window.clearTimeout(typingTimer);
          typingTimer = window.setTimeout(() => {
            typingLine.hidden = true;
          }, 3_000);
          break;
        }
        case 'presence': {
          break;
        }
        default:
          break;
      }
    });

    const retry = () => {
      socket = null;
      if (closedForGood) return;
      reconnectAttempt += 1;
      if (reconnectAttempt > 6) {
        // Give up on the socket and let the poll carry the thread.
        setStatus('Reconnecting…');
        return;
      }
      const delay = Math.min(15_000, 500 * 2 ** reconnectAttempt);
      window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(connect, delay);
    };

    ws.addEventListener('close', retry);
    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  };

  // --- sending --------------------------------------------------------------

  const send = async () => {
    if (!form || !input) return;
    const content = input.value.trim();
    if (!content) return;

    const clientId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimistic: MessageLike = {
      id: clientId,
      conversationId,
      content,
      createdAt: Math.floor(Date.now() / 1000),
      mine: true,
      sender: {
        id: boot.user?.id ?? '',
        username: boot.user?.username ?? '',
        displayName: boot.user?.username ?? '',
        avatarMediaId: null,
      },
    };
    list.insertAdjacentHTML('beforeend', renderBubble(optimistic, true));
    const node = list.lastElementChild as HTMLElement | null;
    input.value = '';
    input.style.height = '';
    toBottom();

    try {
      const body = formPayload(form);
      body.set('content', content);
      body.set('clientId', clientId);
      const data = await api<{ message: MessageLike }>(
        `/api/messages/${encodeURIComponent(conversationId)}`,
        { method: 'POST', body },
      );
      seen.add(data.message.id);
      if (node) {
        node.outerHTML = renderBubble(data.message);
      }
      // The catch-up pass advances `latestCursor` past this message; `seen`
      // keeps it from being appended twice in the meantime.
      void catchUp();
    } catch (error) {
      node?.classList.add('bubble--failed');
      const time = node?.querySelector('.bubble__time');
      if (time) time.textContent = 'Not sent';
      // Put the text back so it is never silently lost.
      if (input && !input.value) input.value = content;
      toast(error instanceof Error ? error.message : 'Could not send the message.', 'error');
    }
  };

  // --- attachments: emoji, stickers, photos, voice ---------------------------

  /**
   * Post an attachment bubble. The optimistic placeholder is rendered from a
   * local object URL so the photo or clip is visible instantly, then replaced
   * by the server's copy — the same swap the text path already does.
   */
  const sendAttachment = async (options: {
    kind: 'image' | 'audio' | 'sticker';
    file?: File | Blob | null;
    content?: string;
    durationMs?: number;
    previewUrl?: string | null;
  }): Promise<void> => {
    const clientId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimistic: MessageLike = {
      id: clientId,
      conversationId,
      content: options.content ?? (options.kind === 'image' ? 'Photo' : 'Voice message'),
      kind: options.kind,
      mediaUrl: options.previewUrl ?? null,
      durationMs: options.durationMs ?? 0,
      createdAt: Math.floor(Date.now() / 1000),
      mine: true,
      sender: {
        id: boot.user?.id ?? '',
        username: boot.user?.username ?? '',
        displayName: boot.user?.username ?? '',
        avatarMediaId: null,
      },
    };
    list.insertAdjacentHTML('beforeend', renderBubble(optimistic, true));
    const node = list.lastElementChild as HTMLElement | null;
    toBottom();

    try {
      const body = new FormData();
      body.set('kind', options.kind);
      body.set('content', options.content ?? '');
      body.set('clientId', clientId);
      if (options.durationMs) body.set('durationMs', String(options.durationMs));
      if (options.file) {
        // A Blob from MediaRecorder has no filename; give it one so the
        // multipart part is a File the Worker can classify.
        const name = options.kind === 'audio' ? 'voice-message' : 'photo';
        body.set('file', options.file, options.file instanceof File ? options.file.name : name);
      }

      const data = await api<{ message: MessageLike }>(
        `/api/messages/${encodeURIComponent(conversationId)}/attachment`,
        { method: 'POST', body },
      );
      seen.add(data.message.id);
      if (node) node.outerHTML = renderBubble(data.message);
      void catchUp();
    } catch (error) {
      node?.classList.add('bubble--failed');
      const time = node?.querySelector('.bubble__time');
      if (time) time.textContent = 'Not sent';
      toast(error instanceof Error ? error.message : 'Could not send the attachment.', 'error');
    } finally {
      // The preview URL has served its purpose either way.
      if (options.previewUrl) window.setTimeout(() => URL.revokeObjectURL(options.previewUrl!), 30_000);
    }
  };

  // Emoji picker. Emoji are plain characters, so inserting one is a text edit;
  // stickers are a separate message kind that renders large and bubble-less.
  const emojiPanel = $<HTMLElement>('[data-emoji-panel]', thread);
  const emojiToggle = $<HTMLElement>('[data-emoji-toggle]', thread);
  if (emojiPanel && emojiToggle) {
    emojiToggle.addEventListener('click', () => {
      const opening = emojiPanel.hidden;
      emojiPanel.hidden = !opening;
      emojiToggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
    });

    emojiPanel.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;

      const emoji = target?.closest<HTMLElement>('[data-emoji]')?.dataset.emoji;
      if (emoji && input) {
        // Insert at the caret rather than appending, so the picker can be used
        // in the middle of a sentence.
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        input.value = `${input.value.slice(0, start)}${emoji}${input.value.slice(end)}`;
        const caret = start + emoji.length;
        input.setSelectionRange(caret, caret);
        input.focus();
        return;
      }

      const sticker = target?.closest<HTMLElement>('[data-sticker]')?.dataset.sticker;
      if (sticker) {
        emojiPanel.hidden = true;
        emojiToggle.setAttribute('aria-expanded', 'false');
        void sendAttachment({ kind: 'sticker', content: sticker });
      }
    });

    document.addEventListener('click', (event) => {
      if (emojiPanel.hidden) return;
      const target = event.target as Node;
      if (!emojiPanel.contains(target) && !emojiToggle.contains(target)) {
        emojiPanel.hidden = true;
        emojiToggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Photos: any caption already typed rides along with the image.
  const photoInput = $<HTMLInputElement>('[data-photo-input]', thread);
  photoInput?.addEventListener('change', () => {
    const file = photoInput.files?.[0];
    if (!file) return;
    const caption = input?.value.trim() ?? '';
    if (input) {
      input.value = '';
      input.style.height = '';
    }
    void sendAttachment({
      kind: 'image',
      file,
      content: caption,
      previewUrl: URL.createObjectURL(file),
    });
    // Allow re-selecting the same file straight afterwards.
    photoInput.value = '';
  });

  // Voice notes. MediaRecorder is not universal, so the button is only wired
  // when the API exists; the rest of the composer is unaffected either way.
  const voiceToggle = $<HTMLElement>('[data-voice-toggle]', thread);
  const voiceBar = $<HTMLElement>('[data-voice-bar]', thread);
  if (voiceToggle && voiceBar) {
    const timeLabel = $<HTMLElement>('[data-voice-time]', voiceBar);
    const hint = $<HTMLElement>('[data-voice-hint]', voiceBar);
    let recorder: MediaRecorder | null = null;
    let chunks: Blob[] = [];
    let stream: MediaStream | null = null;
    let startedAt = 0;
    let ticker = 0;
    let recorded: { blob: Blob; durationMs: number } | null = null;

    const stopTracks = () => {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    };

    const resetBar = () => {
      window.clearInterval(ticker);
      voiceBar.hidden = true;
      voiceBar.classList.remove('is-recording', 'is-ready');
      recorded = null;
      chunks = [];
      recorder = null;
      stopTracks();
      if (timeLabel) timeLabel.textContent = '0:00';
      voiceToggle.setAttribute('aria-pressed', 'false');
    };

    const beginRecording = async () => {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        toast('This browser cannot record audio.', 'error');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        // Almost always a denied permission prompt; say so rather than failing
        // silently with a dead button.
        toast('Microphone access was refused.', 'error');
        return;
      }

      chunks = [];
      recorder = new MediaRecorder(stream);
      startedAt = Date.now();
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size) chunks.push(event.data);
      });
      recorder.addEventListener('stop', () => {
        const durationMs = Date.now() - startedAt;
        stopTracks();
        if (!chunks.length) {
          resetBar();
          return;
        }
        recorded = { blob: new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' }), durationMs };
        voiceBar.classList.remove('is-recording');
        voiceBar.classList.add('is-ready');
        if (hint) hint.textContent = 'Ready to send';
      });
      recorder.start();

      voiceBar.hidden = false;
      voiceBar.classList.add('is-recording');
      voiceBar.classList.remove('is-ready');
      voiceToggle.setAttribute('aria-pressed', 'true');
      if (hint) hint.textContent = 'Recording…';

      window.clearInterval(ticker);
      ticker = window.setInterval(() => {
        const elapsed = Date.now() - startedAt;
        if (timeLabel) timeLabel.textContent = clockDuration(elapsed);
        // Hard stop at five minutes — the server rejects anything longer.
        if (elapsed >= 5 * 60 * 1000) recorder?.stop();
      }, 200);
    };

    voiceToggle.addEventListener('click', () => {
      if (recorder && recorder.state === 'recording') {
        recorder.stop();
        window.clearInterval(ticker);
        return;
      }
      void beginRecording();
    });

    $<HTMLElement>('[data-voice-cancel]', voiceBar)?.addEventListener('click', () => {
      if (recorder && recorder.state === 'recording') recorder.stop();
      resetBar();
    });

    $<HTMLElement>('[data-voice-send]', voiceBar)?.addEventListener('click', () => {
      if (recorder && recorder.state === 'recording') {
        // Send implies stop; the clip is posted from the stop handler's data on
        // the next tick, once the final chunk has arrived.
        recorder.addEventListener(
          'stop',
          () => {
            if (recorded) {
              void sendAttachment({
                kind: 'audio',
                file: recorded.blob,
                durationMs: recorded.durationMs,
                previewUrl: URL.createObjectURL(recorded.blob),
              });
            }
            resetBar();
          },
          { once: true },
        );
        recorder.stop();
        window.clearInterval(ticker);
        return;
      }
      if (recorded) {
        void sendAttachment({
          kind: 'audio',
          file: recorded.blob,
          durationMs: recorded.durationMs,
          previewUrl: URL.createObjectURL(recorded.blob),
        });
      }
      resetBar();
    });
  }

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    void send();
  });

  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  });

  // Grow the composer with its content, up to a few lines.
  input?.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(160, input.scrollHeight)}px`;

    const now = Date.now();
    if (socket?.readyState === WebSocket.OPEN && now - lastTypingSent > 2_000) {
      lastTypingSent = now;
      try {
        socket.send(JSON.stringify({ type: 'typing' }));
      } catch {
        /* ignore */
      }
    }
  });

  // --- older history --------------------------------------------------------

  document.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-thread-older]');
    if (!button) return;
    event.preventDefault();
    const cursor = button.dataset.cursor;
    if (!cursor) return;
    const el = button as HTMLButtonElement;
    el.disabled = true;

    void api<{ items: MessageLike[]; nextCursor: string | null; hasMore: boolean }>(
      `/api/messages/${encodeURIComponent(conversationId)}?before=${encodeURIComponent(cursor)}&limit=30`,
    )
      .then((page) => {
        const before = scroller.scrollHeight;
        const markup = page.items
          .filter((message) => !seen.has(message.id))
          .map((message) => {
            seen.add(message.id);
            return renderBubble(message);
          })
          .join('');
        list.insertAdjacentHTML('afterbegin', markup);
        // Keep the reading position pinned to the same message.
        scroller.scrollTop += scroller.scrollHeight - before;
        if (page.hasMore && page.nextCursor) {
          el.dataset.cursor = page.nextCursor;
          el.disabled = false;
        } else {
          el.closest('.loadmore')?.remove();
        }
      })
      .catch((error) => {
        el.disabled = false;
        toast(error instanceof Error ? error.message : 'Could not load older messages.', 'error');
      });
  });

  // --- lifecycle ------------------------------------------------------------

  toBottom();
  markRead();
  connect();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (!socket || socket.readyState > WebSocket.OPEN) {
      reconnectAttempt = 0;
      connect();
    }
    void catchUp();
  });

  window.addEventListener('pagehide', () => {
    closedForGood = true;
    window.clearTimeout(reconnectTimer);
    try {
      socket?.close(1000, 'navigating');
    } catch {
      /* ignore */
    }
  });

  // Safety net: covers a socket that is open but silently dead, and is the only
  // delivery path when the Durable Object binding is absent.
  window.setInterval(() => {
    if (document.hidden) return;
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: 'ping' }));
      } catch {
        /* ignore */
      }
      return;
    }
    void catchUp();
  }, 10_000);
}

function initMessages(): void {
  if (!boot.user) return;
  void refreshMessagesBadge();
  window.setInterval(() => {
    if (!document.hidden) void refreshMessagesBadge();
  }, 60_000);
  initConversationList();
  initThread();
}

// ---------------------------------------------------------------------------
// Reels
// ---------------------------------------------------------------------------

/**
 * Reel behaviour.
 *
 * The page already works without this: each reel is a `<video controls>` or a
 * platform iframe, and "load more" is an ordinary link. The upgrades here are
 * the ones that make a vertical feed feel right — play the reel in view, pause
 * the ones that are not, like without a reload, and append the next page in
 * place. Embedded reels are left entirely alone: their playback belongs to the
 * platform inside the iframe, which we cannot (and must not) script.
 */
function initReels(): void {
  const feed = $<HTMLElement>('[data-reel-feed]');
  if (!feed) return;

  // Autoplay only what the reader is actually looking at, so a long feed does
  // not decode a dozen videos at once.
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const video = entry.target as HTMLVideoElement;
          if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
            video.play().catch(() => undefined);
          } else {
            video.pause();
          }
        }
      },
      { threshold: [0, 0.6, 1] },
    );
    for (const video of $$<HTMLVideoElement>('[data-reel-video]', feed)) observer.observe(video);

    // Videos appended later need observing too.
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof HTMLElement)) continue;
          for (const video of $$<HTMLVideoElement>('[data-reel-video]', node)) observer.observe(video);
        }
      }
    });
    mutations.observe(feed, { childList: true });
  }

  // Likes: optimistic, then corrected by the authoritative count.
  document.addEventListener('submit', (event) => {
    const form = event.target as HTMLFormElement | null;
    if (!form?.matches('[data-reel-like]')) return;
    event.preventDefault();

    const card = form.closest<HTMLElement>('[data-reel-id]');
    const reelId = card?.dataset.reelId;
    const button = form.querySelector<HTMLButtonElement>('button');
    const counter = form.querySelector<HTMLElement>('[data-reel-likes]');
    if (!reelId || !button) return;

    const wasOn = button.classList.contains('is-on');
    button.classList.toggle('is-on', !wasOn);
    button.setAttribute('aria-pressed', String(!wasOn));
    if (counter) counter.textContent = String(Math.max(0, Number(counter.textContent ?? 0) + (wasOn ? -1 : 1)));

    void api<{ liked: boolean; likeCount: number }>(`/api/reels/${encodeURIComponent(reelId)}/like`, {
      method: 'POST',
    })
      .then((data) => {
        button.classList.toggle('is-on', data.liked);
        button.setAttribute('aria-pressed', String(data.liked));
        if (counter) counter.textContent = String(data.likeCount);
      })
      .catch((error) => {
        // Put the UI back exactly as it was.
        button.classList.toggle('is-on', wasOn);
        button.setAttribute('aria-pressed', String(wasOn));
        if (counter) counter.textContent = String(Math.max(0, Number(counter.textContent ?? 0) + (wasOn ? 1 : -1)));
        toast(error instanceof Error ? error.message : 'Could not save that like.', 'error');
      });
  });

  // Append the next page rather than navigating away from the current reel.
  document.addEventListener('click', (event) => {
    const more = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-reel-more]');
    if (!more) return;
    const cursor = more.dataset.cursor;
    if (!cursor) return;
    event.preventDefault();

    const sort = new URLSearchParams(location.search).get('sort') === 'popular' ? 'popular' : 'latest';
    more.setAttribute('aria-busy', 'true');

    void api<{ items: ReelLike[]; nextCursor: string | null; hasMore: boolean }>(
      `/api/reels?sort=${sort}&cursor=${encodeURIComponent(cursor)}&limit=10`,
    )
      .then((page) => {
        feed.insertAdjacentHTML('beforeend', page.items.map(renderReelCard).join(''));
        if (page.hasMore && page.nextCursor) {
          more.dataset.cursor = page.nextCursor;
          more.removeAttribute('aria-busy');
        } else {
          more.closest('.loadmore')?.remove();
        }
      })
      .catch((error) => {
        more.removeAttribute('aria-busy');
        toast(error instanceof Error ? error.message : 'Could not load more reels.', 'error');
      });
  });

  initReelComposer();
}

interface ReelLike {
  id: string;
  provider: string;
  providerLabel: string;
  sourceUrl: string;
  embedUrl: string;
  videoUrl: string;
  posterUrl: string;
  title: string;
  caption: string;
  viewCount: number;
  likeCount: number;
  createdAt: number;
  viewerLiked: boolean;
  author: { id: string; username: string; displayName: string; avatarMediaId: string | null };
}

/** Client-side twin of the SSR reel card. Everything is escaped. */
function renderReelCard(reel: ReelLike): string {
  const token = csrfToken();
  const stage =
    reel.provider === 'upload' && reel.videoUrl
      ? `<video class="reel__video" src="${escapeHtml(reel.videoUrl)}" playsinline loop muted controls
           preload="none" data-reel-video></video>`
      : reel.embedUrl
        ? `<iframe class="reel__embed" src="${escapeHtml(reel.embedUrl)}" title="${escapeHtml(
            reel.title || `${reel.providerLabel} video`,
          )}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"
           allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
           allowfullscreen></iframe>`
        : '<div class="reel__missing muted">This video is no longer available.</div>';

  const avatar = reel.author.avatarMediaId
    ? `<span class="avatar avatar--sm"><img src="/media/${encodeURIComponent(
        reel.author.avatarMediaId,
      )}?v=thumb" alt="" width="32" height="32" loading="lazy" decoding="async"></span>`
    : `<span class="avatar avatar--sm"><span class="avatar__fallback" aria-hidden="true">${escapeHtml(
        (reel.author.displayName || reel.author.username).slice(0, 2).toUpperCase(),
      )}</span></span>`;

  const like = token
    ? `<form method="post" action="/api/reels/${encodeURIComponent(reel.id)}/like" data-reel-like>
         <input type="hidden" name="_csrf" value="${escapeHtml(token)}">
         <button class="reel__action ${reel.viewerLiked ? 'is-on' : ''}" type="submit"
                 aria-pressed="${reel.viewerLiked}" aria-label="Like this reel">
           \u2665 <span data-reel-likes>${reel.likeCount}</span>
         </button>
       </form>`
    : `<a class="reel__action" href="/login?next=/reels">\u2665 <span>${reel.likeCount}</span></a>`;

  return `<article class="reel" data-reel data-reel-id="${escapeHtml(reel.id)}">
    <div class="reel__stage">${stage}</div>
    <div class="reel__meta">
      <div class="reel__author">
        ${avatar}
        <div class="reel__who">
          <a class="reel__name" href="/u/${encodeURIComponent(reel.author.username)}">${escapeHtml(
            reel.author.displayName,
          )}</a>
          <span class="reel__handle muted">@${escapeHtml(reel.author.username)} \u00B7 ${escapeHtml(
            shortAgo(reel.createdAt),
          )}</span>
        </div>
        <span class="pill pill--source">${escapeHtml(reel.providerLabel)}</span>
      </div>
      ${reel.title ? `<h2 class="reel__title">${escapeHtml(reel.title)}</h2>` : ''}
      ${reel.caption ? `<p class="reel__caption">${escapeHtml(reel.caption)}</p>` : ''}
      <div class="reel__actions">
        ${like}
        <span class="reel__action reel__action--static">\u25B6 <span>${reel.viewCount}</span></span>
        ${
          reel.sourceUrl
            ? `<a class="reel__action" href="${escapeHtml(
                reel.sourceUrl,
              )}" target="_blank" rel="noopener noreferrer nofollow">Watch on ${escapeHtml(
                reel.providerLabel,
              )}</a>`
            : ''
        }
      </div>
    </div>
  </article>`;
}

/**
 * Importing and uploading reels.
 *
 * An upload is two steps — the file goes through the normal media pipeline
 * first, then the returned id is published as a reel — so reels reuse the
 * upload gate (sniffing, quota, rate limit) instead of getting a second one.
 */
function initReelComposer(): void {
  const importForm = $<HTMLFormElement>('[data-reel-import]');
  importForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    showFormError(importForm, null);
    busy(importForm, true);
    void api('/api/reels/import', { method: 'POST', body: formPayload(importForm) })
      .then(() => {
        toast('Reel added');
        location.reload();
      })
      .catch((error) => {
        showFormError(importForm, error instanceof Error ? error.message : 'Could not import that link.');
        busy(importForm, false);
      });
  });

  const uploadForm = $<HTMLFormElement>('[data-reel-upload]');
  uploadForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const file = uploadForm.querySelector<HTMLInputElement>('[data-reel-file]')?.files?.[0];
    if (!file) {
      showFormError(uploadForm, 'Choose a video first.');
      return;
    }
    showFormError(uploadForm, null);
    busy(uploadForm, true);

    const upload = new FormData();
    upload.set('file', file, file.name);
    upload.set('usage', 'post');

    void api<{ media: { id: string } }>('/api/media/upload', { method: 'POST', body: upload })
      .then((data) => {
        const publish = new FormData();
        publish.set('mediaId', data.media.id);
        const caption = uploadForm.querySelector<HTMLInputElement>('input[name="caption"]')?.value ?? '';
        if (caption) publish.set('caption', caption);
        return api('/api/reels', { method: 'POST', body: publish });
      })
      .then(() => {
        toast('Reel published');
        location.reload();
      })
      .catch((error) => {
        showFormError(uploadForm, error instanceof Error ? error.message : 'Could not publish that video.');
        busy(uploadForm, false);
      });
  });
}

/**
 * "Message this person" rows in inbox search: post the form, then land in the
 * conversation it just opened.
 */
function initOpenConversation(): void {
  document.addEventListener('submit', (event) => {
    const form = event.target as HTMLFormElement | null;
    if (!form?.matches('[data-open-conversation]')) return;
    event.preventDefault();
    busy(form, true);
    void api<{ conversationId: string }>('/api/messages', { method: 'POST', body: formPayload(form) })
      .then((data) => {
        location.href = `/messages/${encodeURIComponent(data.conversationId)}`;
      })
      .catch((error) => {
        busy(form, false);
        toast(error instanceof Error ? error.message : 'Could not open that conversation.', 'error');
      });
  });
}

function init(): void {
  initTheme();
  initDelegatedClicks();
  initForms();
  initNotifications();
  initStatusDashboard();
  initLiveFeed();
  markClamped();
  initInfiniteScroll();
  initComposerDraft();
  initReaderExtras();
  initMedia();
  initCommunityActions();
  initMessages();
  initNotificationPanel();
  initAccountMenu();
  initReels();
  initOpenConversation();
}

function initInfiniteScroll(): void {
  const more = $<HTMLElement>('[data-load-more]');
  if (!more || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) void loadMoreFeed(more);
  });
  io.observe(more);
}

function initComposerDraft(): void {
  const field = $<HTMLTextAreaElement>('[data-composer-content]');
  if (!field) return;

  // Grow the compact composer with its content, up to a sensible ceiling.
  if (field.hasAttribute('data-autogrow')) {
    const grow = () => {
      field.style.height = 'auto';
      field.style.height = `${Math.min(224, Math.max(42, field.scrollHeight))}px`;
    };
    field.addEventListener('input', grow);
    grow();
  }
  const key = 'aes-draft';
  try {
    const saved = localStorage.getItem(key);
    if (saved && !field.value) field.value = saved;
  } catch {
    /* private mode */
  }
  field.addEventListener('input', () => {
    try {
      localStorage.setItem(key, field.value);
    } catch {
      /* ignore */
    }
  });
  document.addEventListener('submit', (event) => {
    const form = event.target as HTMLFormElement;
    if (form?.matches('[data-composer]')) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
  });
}

function initReaderExtras(): void {
  const article = $('.post .prose');
  const tocList = $<HTMLElement>('[data-toc-list]');
  const toc = $<HTMLElement>('[data-toc]');
  if (article && tocList && toc) {
    const heads = Array.from(article.querySelectorAll('h2, h3'));
    if (heads.length) {
      toc.hidden = false;
      heads.forEach((h, i) => {
        if (!h.id) h.id = `h-${i}`;
        const li = document.createElement('li');
        li.innerHTML = `<a href="#${h.id}">${escapeHtml(h.textContent || '')}</a>`;
        tocList.appendChild(li);
      });
    }
  }

  const bar = $<HTMLElement>('[data-read-progress]');
  if (bar && article) {
    bar.hidden = false;
    const onScroll = () => {
      const rect = article.getBoundingClientRect();
      const total = article.scrollHeight - window.innerHeight;
      const done = Math.min(100, Math.max(0, ((-rect.top) / Math.max(1, total)) * 100));
      bar.style.width = `${done}%`;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  const related = $<HTMLElement>('[data-related]');
  if (related?.dataset.postId) {
    void api<{ posts: { slug: string; title: string; author: string }[] }>(
      `/api/community/related/${encodeURIComponent(related.dataset.postId)}`,
    )
      .then((data) => {
        const host = $('[data-related-list]', related);
        if (!host) return;
        host.innerHTML = (data.posts || [])
          .map(
            (p) =>
              `<a class="related__item" href="/post/${encodeURIComponent(p.slug)}">${escapeHtml(p.title)} <span class="muted">@${escapeHtml(p.author)}</span></a>`,
          )
          .join('');
      })
      .catch(() => undefined);
  }

  document.addEventListener('click', (event) => {
    const t = event.target as HTMLElement | null;
    if (t?.closest('[data-reader-mode]')) {
      document.body.classList.toggle('is-reader');
    }
  });
}

/**
 * Image viewing. Lives on its own (not inside the reader extras) because the
 * feed, profiles and comments all render `[data-lightbox]` links — binding it
 * only on post pages is why "click to enlarge" used to do nothing elsewhere.
 */
function initMedia(): void {
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const imgLink = target?.closest<HTMLAnchorElement>('[data-lightbox]');
    if (!imgLink) return;
    // Let modified clicks (new tab/window, download) behave natively.
    const mouse = event as MouseEvent;
    if (mouse.metaKey || mouse.ctrlKey || mouse.shiftKey || mouse.altKey || mouse.button > 0) return;
    // If the thumbnail itself failed to load there is nothing to enlarge —
    // fall through to a plain navigation so the user still sees the reason.
    const img = imgLink.querySelector('img');
    if (img && img.dataset.failed === '1') return;
    event.preventDefault();
    openLightbox(imgLink.href);
  });

  // A broken tile is marked so CSS can show a labelled placeholder instead of
  // collapsing to bare alt text.
  document.addEventListener(
    'error',
    (event) => {
      const img = event.target as HTMLImageElement | null;
      if (!img || img.tagName !== 'IMG') return;
      if (img.dataset.failed === '1') return;
      img.dataset.failed = '1';
      img.closest('.mediagrid__item, .avatar')?.classList.add('is-broken');
    },
    true,
  );
}

function openLightbox(src: string): void {
  const existing = $('.lightbox');
  existing?.remove();
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.innerHTML = `<button type="button" class="lightbox__close" aria-label="Close">×</button><img src="${escapeHtml(src)}" alt="">`;
  const close = () => {
    box.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  box.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(box);
  box.querySelector<HTMLButtonElement>('.lightbox__close')?.focus();
}

function initCommunityActions(): void {
  document.addEventListener('submit', (event) => {
    const form = event.target as HTMLFormElement | null;
    if (!form?.matches('[data-poll]')) return;
    event.preventDefault();
    const postId = form.dataset.postId ?? '';
    const picked = form.querySelector<HTMLInputElement>('input[name="optionId"]:checked');
    if (!postId || !picked) return;
    const body = new FormData();
    body.set('optionId', picked.value);
    void api<{ options: { id: string; voteCount: number }[] }>(
      `/api/community/vote/${encodeURIComponent(postId)}`,
      { method: 'POST', body },
    )
      .then((data) => {
        for (const opt of data.options) {
          const row = form.querySelector(`[value="${CSS.escape(opt.id)}"]`)?.closest('label');
          const count = row?.querySelector('.muted');
          if (count) count.textContent = String(opt.voteCount);
        }
        toast('Vote saved');
      })
      .catch((error) => toast(error instanceof Error ? error.message : 'Could not vote', 'error'));
  });

  document.addEventListener('click', (event) => {
    const t = event.target as HTMLElement | null;
    const quote = t?.closest('[data-quote-comment]');
    if (quote) {
      const comment = quote.closest('[data-comment-id]');
      const author = comment?.querySelector('.comment__author')?.textContent?.trim() ?? 'someone';
      const text = comment?.querySelector('.prose')?.textContent?.trim() ?? '';
      const area = $<HTMLTextAreaElement>('[data-comment-form] textarea');
      if (area) {
        area.value = `> @${author}: ${text.slice(0, 280)}\n\n${area.value}`;
        area.focus();
      }
    }

    const repost = t?.closest<HTMLElement>('[data-repost]');
    if (repost?.dataset.postId) {
      event.preventDefault();
      void api(`/api/community/repost/${encodeURIComponent(repost.dataset.postId)}`, { method: 'POST' })
        .then(() => {
          toast('Reposted');
          location.reload();
        })
        .catch((error) => toast(error instanceof Error ? error.message : 'Could not repost', 'error'));
    }

    const who = t?.closest<HTMLElement>('[data-who-liked]');
    if (who?.dataset.postId) {
      event.preventDefault();
      void api<{ people: { username: string; displayName: string; reaction: string }[] }>(
        `/api/community/reactions/${encodeURIComponent(who.dataset.postId)}`,
      )
        .then((data) => {
          const names = data.people.map((p) => `@${p.username} (${p.reaction})`).join(', ') || 'No reactions yet';
          toast(names);
        })
        .catch(() => toast('Could not load reactions', 'error'));
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

export {};
