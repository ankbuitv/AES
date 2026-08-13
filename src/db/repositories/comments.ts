/**
 * Comment repository.
 *
 * Threads are stored flat with `parent_id`, `root_id` and a precomputed
 * `depth` (0..LIMITS.commentMaxDepth). Storing the depth means the nesting
 * limit is enforced with a single read instead of walking the ancestor chain,
 * and a whole thread loads with one indexed query on `root_id`.
 */

import { Db, placeholders } from '../client';
import type { CommentRow, CommentStatus } from '../../types/models';
import { newId } from '../../utils/id';
import { now } from '../../utils/time';
import type { Cursor } from '../../utils/cursor';

export interface CommentWithAuthor extends CommentRow {
  author_username: string;
  author_display_name: string;
  author_avatar_media_id: string | null;
  author_role: string;
  author_level: number;
  post_slug: string;
  post_author_id: string;
}

const COMMENT_SELECT = `
  c.*,
  u.username        AS author_username,
  u.display_name    AS author_display_name,
  u.avatar_media_id AS author_avatar_media_id,
  u.role            AS author_role,
  u.level           AS author_level,
  p.slug            AS post_slug,
  p.author_id       AS post_author_id
`;

const COMMENT_JOINS = `
  FROM comments c
  JOIN users u ON u.id = c.author_id
  JOIN posts p ON p.id = c.post_id
`;

export class CommentRepository {
  constructor(private readonly db: Db) {}

  async findById(id: string): Promise<CommentWithAuthor | null> {
    return this.db.first<CommentWithAuthor>(
      `SELECT ${COMMENT_SELECT} ${COMMENT_JOINS} WHERE c.id = ?`,
      [id],
    );
  }

  async findRaw(id: string): Promise<CommentRow | null> {
    return this.db.first<CommentRow>('SELECT * FROM comments WHERE id = ?', [id]);
  }

  /**
   * Insert a comment and bump the post's comment counter in one batch so the
   * denormalised count can never drift from the rows.
   */
  async create(input: {
    postId: string;
    authorId: string;
    parentId: string | null;
    rootId: string | null;
    depth: number;
    content: string;
  }): Promise<string> {
    const id = newId('cmt');
    const ts = now();

    const statements = [
      {
        sql: `INSERT INTO comments
                (id, post_id, author_id, parent_id, root_id, depth, content, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)`,
        params: [
          id,
          input.postId,
          input.authorId,
          input.parentId,
          input.rootId ?? id,
          input.depth,
          input.content,
          ts,
          ts,
        ] as (string | number | null)[],
      },
      {
        sql: 'UPDATE posts SET comment_count = comment_count + 1, updated_at = ? WHERE id = ?',
        params: [ts, input.postId] as (string | number | null)[],
      },
    ];

    if (input.parentId) {
      statements.push({
        sql: 'UPDATE comments SET reply_count = reply_count + 1 WHERE id = ?',
        params: [input.parentId],
      });
    }

    await this.db.batch(statements);
    return id;
  }

  async update(id: string, content: string): Promise<void> {
    const ts = now();
    await this.db.run(
      'UPDATE comments SET content = ?, updated_at = ?, edited_at = ? WHERE id = ?',
      [content, ts, ts, id],
    );
  }

  /**
   * Soft delete: the row stays so replies keep their parent, but the content
   * is cleared and the status flips to `deleted`.
   */
  async softDelete(id: string, postId: string): Promise<void> {
    const ts = now();
    await this.db.batch([
      {
        sql: `UPDATE comments SET status = 'deleted', content = '', updated_at = ?
              WHERE id = ? AND status <> 'deleted'`,
        params: [ts, id],
      },
      {
        sql: `UPDATE posts SET comment_count = MAX(0, comment_count - 1) WHERE id = ?`,
        params: [postId],
      },
    ]);
  }

  async setStatus(id: string, status: CommentStatus): Promise<void> {
    await this.db.run('UPDATE comments SET status = ?, updated_at = ? WHERE id = ?', [
      status,
      now(),
      id,
    ]);
  }

  /**
   * Top-level comments for a post, newest-first, cursor paginated.
   * Deleted roots are kept when they still have visible replies (a "[deleted]"
   * tombstone) so the thread does not collapse.
   */
  async listRoots(options: {
    postId: string;
    cursor: Cursor | null;
    limit: number;
    order?: 'newest' | 'oldest' | 'top';
  }): Promise<CommentWithAuthor[]> {
    const where: string[] = [
      'c.post_id = ?',
      'c.parent_id IS NULL',
      `(c.status = 'published' OR (c.status = 'deleted' AND c.reply_count > 0))`,
    ];
    const params: (string | number)[] = [options.postId];

    let orderBy = 'c.created_at DESC, c.id DESC';
    let cursorClause = '(c.created_at < ? OR (c.created_at = ? AND c.id < ?))';

    if (options.order === 'oldest') {
      orderBy = 'c.created_at ASC, c.id ASC';
      cursorClause = '(c.created_at > ? OR (c.created_at = ? AND c.id > ?))';
    } else if (options.order === 'top') {
      orderBy = 'c.reaction_count DESC, c.created_at DESC, c.id DESC';
      cursorClause = '(c.reaction_count < ? OR (c.reaction_count = ? AND c.id < ?))';
    }

    if (options.cursor) {
      where.push(cursorClause);
      params.push(options.cursor.v, options.cursor.v, options.cursor.i);
    }

    return this.db.all<CommentWithAuthor>(
      `SELECT ${COMMENT_SELECT} ${COMMENT_JOINS}
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT ?`,
      [...params, options.limit + 1],
    );
  }

  /** All descendants of the given roots — one query for the whole page. */
  async listRepliesForRoots(rootIds: string[], maxPerRoot = 200): Promise<CommentWithAuthor[]> {
    if (!rootIds.length) return [];
    return this.db.all<CommentWithAuthor>(
      `SELECT ${COMMENT_SELECT} ${COMMENT_JOINS}
       WHERE c.root_id IN (${placeholders(rootIds.length)})
         AND c.parent_id IS NOT NULL
         AND (c.status = 'published' OR (c.status = 'deleted' AND c.reply_count > 0))
       ORDER BY c.created_at ASC, c.id ASC
       LIMIT ?`,
      [...rootIds, rootIds.length * maxPerRoot],
    );
  }

  /** Direct replies to one comment (the "show more replies" endpoint). */
  async listReplies(options: {
    parentId: string;
    cursor: Cursor | null;
    limit: number;
  }): Promise<CommentWithAuthor[]> {
    const where = ['c.parent_id = ?', `c.status = 'published'`];
    const params: (string | number)[] = [options.parentId];
    if (options.cursor) {
      where.push('(c.created_at > ? OR (c.created_at = ? AND c.id > ?))');
      params.push(options.cursor.v, options.cursor.v, options.cursor.i);
    }
    return this.db.all<CommentWithAuthor>(
      `SELECT ${COMMENT_SELECT} ${COMMENT_JOINS}
       WHERE ${where.join(' AND ')}
       ORDER BY c.created_at ASC, c.id ASC
       LIMIT ?`,
      [...params, options.limit + 1],
    );
  }

  /** Profile "Replies" tab. */
  async byAuthor(options: {
    authorId: string;
    cursor: Cursor | null;
    limit: number;
  }): Promise<CommentWithAuthor[]> {
    const where = ['c.author_id = ?', `c.status = 'published'`, `p.status = 'published'`, `p.visibility = 'public'`];
    const params: (string | number)[] = [options.authorId];
    if (options.cursor) {
      where.push('(c.created_at < ? OR (c.created_at = ? AND c.id < ?))');
      params.push(options.cursor.v, options.cursor.v, options.cursor.i);
    }
    return this.db.all<CommentWithAuthor>(
      `SELECT ${COMMENT_SELECT} ${COMMENT_JOINS}
       WHERE ${where.join(' AND ')}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ?`,
      [...params, options.limit + 1],
    );
  }

  async countForPost(postId: string): Promise<number> {
    return (
      (await this.db.scalar<number>(
        `SELECT COUNT(*) FROM comments WHERE post_id = ? AND status = 'published'`,
        [postId],
      )) ?? 0
    );
  }

  async listForAdmin(options: { cursor: Cursor | null; limit: number; status?: string }) {
    const where: string[] = ['1 = 1'];
    const params: (string | number)[] = [];
    if (options.status) {
      where.push('c.status = ?');
      params.push(options.status);
    }
    if (options.cursor) {
      where.push('(c.created_at < ? OR (c.created_at = ? AND c.id < ?))');
      params.push(options.cursor.v, options.cursor.v, options.cursor.i);
    }
    return this.db.all<CommentWithAuthor>(
      `SELECT ${COMMENT_SELECT} ${COMMENT_JOINS}
       WHERE ${where.join(' AND ')}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ?`,
      [...params, options.limit + 1],
    );
  }
}
