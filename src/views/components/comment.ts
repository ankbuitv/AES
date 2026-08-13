/**
 * Comment thread rendering.
 *
 * Comments arrive as a flat list with a `depth` (0–4, enforced server-side)
 * and are nested here into `<ul>`/`<li>` so the structure is meaningful to
 * screen readers. Deleted comments are tombstoned rather than removed, which
 * keeps replies attached to something.
 */

import { html, raw } from '../../utils/html';
import type { CommentDTO } from '../../types/models';
import { relativeTime, toIso } from '../../utils/time';
import { avatar } from './avatar';
import { LIMITS } from '../../config';

/** Nest a flat, parent-ordered list into a tree. */
export function nestComments(flat: CommentDTO[]): CommentDTO[] {
  const byId = new Map<string, CommentDTO & { replies: CommentDTO[] }>();
  for (const comment of flat) byId.set(comment.id, { ...comment, replies: [] });

  const roots: CommentDTO[] = [];
  for (const comment of byId.values()) {
    const parent = comment.parentId ? byId.get(comment.parentId) : undefined;
    if (parent) parent.replies.push(comment);
    else roots.push(comment);
  }
  return roots;
}

function commentItem(comment: CommentDTO, canReply: boolean): string {
  const deleted = comment.status === 'deleted' || comment.status === 'hidden';
  return html`
    <li class="comment" id="comment-${comment.id}" data-comment-id="${comment.id}" data-depth="${comment.depth}">
      <article class="comment__body ${deleted ? 'is-tombstone' : ''}" aria-label="Comment by ${comment.author.username}">
        ${deleted
          ? raw(html`<p class="comment__deleted">${comment.status === 'hidden' ? 'This comment was hidden by a moderator.' : 'This comment was deleted.'}</p>`)
          : raw(html`
              <div class="comment__head">
                ${avatar(comment.author, 'sm')}
                <a class="comment__author" href="/u/${comment.author.username}">${comment.author.displayName || comment.author.username}</a>
                <span class="comment__sub">
                  <time datetime="${toIso(comment.createdAt)}">${relativeTime(comment.createdAt)}</time>
                  ${comment.editedAt ? raw(html`· <span class="muted">edited</span>`) : ''}
                </span>
              </div>
              <div class="prose prose--sm">${raw(comment.html)}</div>
              <div class="comment__actions">
                <button class="action action--sm ${comment.viewerReaction ? 'is-active' : ''}" type="button"
                        data-comment-react data-target-id="${comment.id}"
                        aria-pressed="${comment.viewerReaction ? 'true' : 'false'}">
                  👍 <span data-reaction-count>${comment.reactionCount}</span>
                </button>
                ${canReply && comment.depth < LIMITS.commentMaxDepth
                  ? raw(html`<button class="action action--sm" type="button" data-reply-to="${comment.id}">Reply</button>`)
                  : ''}
                ${comment.canEdit
                  ? raw(html`<button class="action action--sm" type="button" data-edit-comment="${comment.id}">Edit</button>`)
                  : ''}
                ${comment.canDelete
                  ? raw(html`<button class="action action--sm action--danger" type="button" data-delete-comment="${comment.id}">Delete</button>`)
                  : ''}
                ${!comment.canEdit
                  ? raw(html`<button class="action action--sm" type="button" data-report data-target-type="comment" data-target-id="${comment.id}">Report</button>`)
                  : ''}
              </div>`)}
      </article>
      ${comment.replies && comment.replies.length
        ? raw(html`<ul class="comment__replies">${comment.replies.map((reply) => raw(commentItem(reply, canReply)))}</ul>`)
        : ''}
    </li>
  `;
}

export interface CommentThreadInput {
  postId: string;
  comments: CommentDTO[];
  nextCursor: string | null;
  canReply: boolean;
  commentsLocked: boolean;
  csrfToken: string | null;
  total: number;
}

export function commentThread(input: CommentThreadInput): string {
  const tree = nestComments(input.comments);

  return html`
    <section class="comments" id="comments" aria-labelledby="comments-heading" data-comments data-post-id="${input.postId}">
      <h2 class="section__title" id="comments-heading">${input.total} ${input.total === 1 ? 'comment' : 'comments'}</h2>

      ${input.commentsLocked
        ? raw(html`<p class="notice">Comments are closed on this post.</p>`)
        : input.canReply
          ? raw(html`
              <form class="commentform" data-comment-form method="post" action="/api/posts/${input.postId}/comments">
                <input type="hidden" name="_csrf" value="${input.csrfToken ?? ''}">
                <input type="hidden" name="parentId" value="" data-parent-input>
                <p class="commentform__replying is-hidden" data-replying hidden>
                  Replying to <span data-replying-to></span>
                  <button type="button" class="linkbtn" data-cancel-reply>Cancel</button>
                </p>
                <label class="sr-only" for="comment-content">Write a comment</label>
                <textarea id="comment-content" name="content" rows="3" required
                          maxlength="${LIMITS.commentContentMax}"
                          placeholder="Add to the conversation…"></textarea>
                <div class="commentform__foot">
                  <span class="muted" data-char-count>0 / ${LIMITS.commentContentMax}</span>
                  <button class="btn btn--primary" type="submit">Comment</button>
                </div>
              </form>`)
          : raw(html`<p class="notice"><a href="/login">Sign in</a> to join the conversation.</p>`)}

      <ul class="comment__list" data-comment-list>
        ${tree.length ? tree.map((comment) => raw(commentItem(comment, input.canReply))) : raw('')}
      </ul>

      ${!tree.length ? raw(html`<p class="muted">No comments yet — be the first.</p>`) : ''}

      ${input.nextCursor
        ? raw(html`<button class="btn btn--ghost btn--block" type="button" data-load-more-comments data-cursor="${input.nextCursor}">
            Load more comments
          </button>`)
        : ''}
    </section>
  `;
}
