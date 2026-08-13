/**
 * Single post page (`/post/{slug}`): the article, its comment thread and a
 * small "more from this author" rail block.
 */

import { html, raw } from '../../utils/html';
import type { CommentDTO, PostDTO } from '../../types/models';
import { postArticle } from '../components/post';
import { commentThread } from '../components/comment';
import { avatar } from '../components/avatar';

export interface PostPageInput {
  post: PostDTO;
  comments: CommentDTO[];
  commentsCursor: string | null;
  commentTotal: number;
  canReply: boolean;
  csrfToken: string | null;
}

export function renderPostPage(input: PostPageInput): string {
  return html`
    <nav class="backlink" aria-label="Breadcrumb">
      <a href="/">← Back to the feed</a>
    </nav>

    ${raw(postArticle(input.post))}

    <aside class="related" data-related data-post-id="${input.post.id}">
      <h2 class="section__title">Cùng chủ đề</h2>
      <div class="related__list" data-related-list></div>
    </aside>

    <div class="readerbar">
      <button class="btn btn--ghost btn--small" type="button" data-reader-mode>Reader mode</button>
      <a class="btn btn--ghost btn--small" href="#comments">Comments</a>
    </div>
    <div class="read-progress" data-read-progress hidden></div>
    <nav class="toc" data-toc hidden><strong>Mục lục</strong><ol data-toc-list></ol></nav>

    ${raw(
      commentThread({
        postId: input.post.id,
        comments: input.comments,
        nextCursor: input.commentsCursor,
        canReply: input.canReply,
        commentsLocked: false,
        csrfToken: input.csrfToken,
        total: input.commentTotal,
      }),
    )}
  `;
}

/** Author card shown in the right rail of a post page. */
export function authorRail(post: PostDTO): string {
  const author = post.author;
  return html`
    <section class="widget widget--author" aria-labelledby="widget-author">
      <h2 class="widget__title" id="widget-author">About the author</h2>
      <div class="widget__person">
        ${avatar(author, 'md')}
        <div class="widget__person-meta">
          <a class="widget__person-name" href="/u/${author.username}">${author.displayName || author.username}</a>
          <span class="muted">@${author.username} · Lv ${author.level}</span>
        </div>
      </div>
      ${author.bio ? raw(html`<p class="muted">${author.bio}</p>`) : ''}
      <dl class="statgrid">
        <div><dt>Posts</dt><dd>${author.postCount}</dd></div>
        <div><dt>Followers</dt><dd>${author.followerCount}</dd></div>
        <div><dt>Following</dt><dd>${author.followingCount}</dd></div>
      </dl>
      <a class="btn btn--ghost btn--block" href="/u/${author.username}">View profile</a>
    </section>
  `;
}
