/**
 * `/compose` — the full editor, for anything longer than the inline composer.
 *
 * It is one multipart form posting to `POST /api/posts`, so it works without
 * JavaScript. The client enhances it with a live character counter, a Markdown
 * preview and drag-and-drop uploads.
 */

import { html, raw } from '../../utils/html';
import { LIMITS } from '../../config';
import type { PostContentType, Visibility } from '../../types/models';

export interface ComposePageInput {
  csrfToken: string | null;
  categories: { slug: string; name: string }[];
  /** Prefilled values when re-editing after a validation failure. */
  draft?: {
    title?: string;
    content?: string;
    contentType?: PostContentType;
    visibility?: Visibility;
    tags?: string;
    category?: string;
    linkUrl?: string;
    codeLanguage?: string;
  };
  error?: string | null;
}

const CONTENT_TYPES: { value: PostContentType; label: string; hint: string }[] = [
  { value: 'markdown', label: 'Post', hint: 'Markdown with links, lists and code.' },
  { value: 'article', label: 'Article', hint: 'Long form. A title is required.' },
  { value: 'image', label: 'Image', hint: 'One or more pictures with a caption.' },
  { value: 'link', label: 'Link', hint: 'Share a URL with your take on it.' },
  { value: 'code', label: 'Code', hint: 'A snippet with syntax language.' },
];

export function renderComposePage(input: ComposePageInput): string {
  const draft = input.draft ?? {};
  const selectedType = draft.contentType ?? 'markdown';

  if (!input.csrfToken) {
    return html`
      <div class="pagehead"><h1 class="pagehead__title">Sign in to post</h1></div>
      <p class="muted">You need an account to publish. <a href="/login?next=/compose">Sign in</a> or
        <a href="/register">create one</a>.</p>
    `;
  }

  return html`
    <div class="pagehead">
      <h1 class="pagehead__title">New post</h1>
      <p class="pagehead__sub muted">Markdown is supported. Raw HTML is stripped.</p>
    </div>

    ${input.error ? raw(html`<p class="alert alert--error" role="alert">${input.error}</p>`) : ''}

    <form class="composer composer--full" method="post" action="/api/posts" enctype="multipart/form-data"
          data-composer data-redirect-to-post="1">
      <input type="hidden" name="_csrf" value="${input.csrfToken}">

      <fieldset class="field">
        <legend>Type</legend>
        <div class="typepicker">
          ${CONTENT_TYPES.map(
            (type) => raw(html`
              <label class="typepicker__option">
                <input type="radio" name="contentType" value="${type.value}"
                       ${type.value === selectedType ? raw('checked') : ''} data-composer-type>
                <span class="typepicker__label">${type.label}</span>
                <span class="typepicker__hint muted">${type.hint}</span>
              </label>`),
          )}
        </div>
      </fieldset>

      <div class="field">
        <label for="title">Title <span class="muted">(required for articles)</span></label>
        <input id="title" name="title" type="text" maxlength="${LIMITS.postTitleMax}" value="${draft.title ?? ''}">
      </div>

      <div class="field">
        <label for="content">Body</label>
        <textarea id="content" name="content" rows="14" required
                  maxlength="${LIMITS.postContentMax}" data-composer-content
                  placeholder="Write something worth reading…">${draft.content ?? ''}</textarea>
        <p class="composer__hint muted">
          <span data-char-count data-max="${LIMITS.postContentMax}">0</span> / ${LIMITS.postContentMax} characters
        </p>
      </div>

      <div class="field">
        <label for="linkUrl">Link URL <span class="muted">(link posts)</span></label>
        <input id="linkUrl" name="linkUrl" type="url" maxlength="2000" value="${draft.linkUrl ?? ''}"
               placeholder="https://example.com/article">
      </div>

      <div class="field">
        <label for="codeLanguage">Code language <span class="muted">(code posts)</span></label>
        <input id="codeLanguage" name="codeLanguage" type="text" maxlength="24" value="${draft.codeLanguage ?? ''}"
               placeholder="typescript" autocapitalize="none" spellcheck="false">
      </div>

      <div class="field">
        <label class="filebtn" for="compose-image">
          <input id="compose-image" type="file" name="image" accept="image/png,image/jpeg,image/webp,image/gif"
                 multiple data-composer-file>
          <span>Attach images</span>
        </label>
        <p class="composer__hint muted">Up to ${LIMITS.mediaPerPost} images, 10 MB each. JPEG, PNG, WebP or GIF.</p>
        <ul class="composer__attachments" data-composer-attachments></ul>
      </div>

      <div class="composer__row">
        <div class="field">
          <label for="category">Category</label>
          <select id="category" name="category">
            <option value="">No category</option>
            ${input.categories.map(
              (category) => raw(html`
                <option value="${category.slug}" ${category.slug === draft.category ? raw('selected') : ''}>
                  ${category.name}
                </option>`),
            )}
          </select>
        </div>

        <div class="field">
          <label for="tags">Tags</label>
          <input id="tags" name="tags" type="text" value="${draft.tags ?? ''}"
                 placeholder="design, workers, d1" autocapitalize="none" spellcheck="false">
          <p class="field__hint">Separate with commas. Up to ${LIMITS.tagsPerPost}.</p>
        </div>

        <div class="field">
          <label for="visibility">Visibility</label>
          <select id="visibility" name="visibility">
            <option value="public" ${draft.visibility === 'public' || !draft.visibility ? raw('selected') : ''}>Public</option>
            <option value="followers" ${draft.visibility === 'followers' ? raw('selected') : ''}>Followers only</option>
            <option value="private" ${draft.visibility === 'private' ? raw('selected') : ''}>Only me</option>
          </select>
        </div>
      </div>

      <div class="composer__foot">
        <button class="btn btn--ghost" type="submit" name="status" value="draft">Save draft</button>
        <button class="btn btn--primary" type="submit" name="status" value="published">Publish</button>
      </div>
      <p class="form__error" data-form-error role="alert" hidden></p>
    </form>
  `;
}
