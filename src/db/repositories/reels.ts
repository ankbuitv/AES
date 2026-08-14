/**
 * Reel repository — short vertical videos.
 *
 * One table holds both self-hosted uploads and third-party embeds so a single
 * indexed query produces the mixed feed. Every read is filtered to
 * `status = 'published'` inside the SQL (rather than by the caller) so a hidden
 * or deleted reel cannot leak through a route that forgot to check.
 */

import { Db } from '../client';
import { newId } from '../../utils/id';
import { now } from '../../utils/time';
import type { Cursor } from '../../utils/cursor';
import type { ReelProvider } from '../../services/reelSources';

export interface ReelRow {
  id: string;
  author_id: string;
  provider: ReelProvider;
  external_id: string;
  source_url: string;
  embed_url: string;
  media_id: string | null;
  poster_url: string;
  title: string;
  caption: string;
  status: string;
  view_count: number;
  like_count: number;
  comment_count: number;
  created_at: number;
  updated_at: number;
  // Joined author columns.
  username: string;
  display_name: string;
  avatar_media_id: string | null;
  level: number;
  role: string;
  // Present only when the query was run for a signed-in viewer.
  viewer_liked?: number | null;
}

export type ReelSort = 'latest' | 'popular';

const COLUMNS = `r.id, r.author_id, r.provider, r.external_id, r.source_url, r.embed_url,
       r.media_id, r.poster_url, r.title, r.caption, r.status, r.view_count,
       r.like_count, r.comment_count, r.created_at, r.updated_at,
       u.username, u.display_name, u.avatar_media_id, u.level, u.role`;

export interface CreateReelInput {
  authorId: string;
  provider: ReelProvider;
  externalId: string;
  sourceUrl: string;
  embedUrl: string;
  mediaId: string | null;
  posterUrl: string;
  title: string;
  caption: string;
}

export class ReelRepository {
  constructor(private readonly db: Db) {}

  async create(input: CreateReelInput): Promise<string> {
    const id = newId('rel');
    const ts = now();
    await this.db.run(
      `INSERT INTO reels (id, author_id, provider, external_id, source_url, embed_url,
                          media_id, poster_url, title, caption, status,
                          view_count, like_count, comment_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', 0, 0, 0, ?, ?)`,
      [
        id,
        input.authorId,
        input.provider,
        input.externalId,
        input.sourceUrl,
        input.embedUrl,
        input.mediaId,
        input.posterUrl,
        input.title,
        input.caption,
        ts,
        ts,
      ],
    );
    return id;
  }

  /** An already-imported embed, so the same reel is never stored twice. */
  async findByExternal(provider: ReelProvider, externalId: string): Promise<ReelRow | null> {
    if (!externalId) return null;
    return this.db.first<ReelRow>(
      `SELECT ${COLUMNS} FROM reels r JOIN users u ON u.id = r.author_id
       WHERE r.provider = ? AND r.external_id = ? AND r.status = 'published'`,
      [provider, externalId],
    );
  }

  async findById(id: string, viewerId: string | null): Promise<ReelRow | null> {
    if (viewerId) {
      return this.db.first<ReelRow>(
        `SELECT ${COLUMNS},
                (SELECT 1 FROM reel_likes l WHERE l.reel_id = r.id AND l.user_id = ?) AS viewer_liked
         FROM reels r JOIN users u ON u.id = r.author_id
         WHERE r.id = ? AND r.status = 'published'`,
        [viewerId, id],
      );
    }
    return this.db.first<ReelRow>(
      `SELECT ${COLUMNS} FROM reels r JOIN users u ON u.id = r.author_id
       WHERE r.id = ? AND r.status = 'published'`,
      [id],
    );
  }

  /**
   * A page of the reel feed. `limit + 1` rows are fetched so the caller can
   * detect a further page without a COUNT.
   */
  async list(options: {
    sort: ReelSort;
    viewerId: string | null;
    authorId?: string | null;
    provider?: ReelProvider | null;
    cursor: Cursor | null;
    limit: number;
  }): Promise<ReelRow[]> {
    const params: (string | number)[] = [];
    const liked = options.viewerId
      ? `(SELECT 1 FROM reel_likes l WHERE l.reel_id = r.id AND l.user_id = ?) AS viewer_liked`
      : `NULL AS viewer_liked`;
    if (options.viewerId) params.push(options.viewerId);

    const where: string[] = [`r.status = 'published'`];
    if (options.authorId) {
      where.push('r.author_id = ?');
      params.push(options.authorId);
    }
    if (options.provider) {
      where.push('r.provider = ?');
      params.push(options.provider);
    }

    // Keyset pagination on the same pair the ORDER BY uses, so paging stays
    // stable while new reels are being posted.
    const sortColumn = options.sort === 'popular' ? 'r.like_count' : 'r.created_at';
    if (options.cursor) {
      where.push(`(${sortColumn} < ? OR (${sortColumn} = ? AND r.id < ?))`);
      params.push(options.cursor.v, options.cursor.v, options.cursor.i);
    }
    params.push(options.limit + 1);

    return this.db.all<ReelRow>(
      `SELECT ${COLUMNS}, ${liked}
       FROM reels r JOIN users u ON u.id = r.author_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${sortColumn} DESC, r.id DESC
       LIMIT ?`,
      params,
    );
  }

  /** Idempotent like. Returns the new like count. */
  async like(reelId: string, userId: string): Promise<number> {
    await this.db.run(
      'INSERT OR IGNORE INTO reel_likes (reel_id, user_id, created_at) VALUES (?, ?, ?)',
      [reelId, userId, now()],
    );
    return this.syncLikeCount(reelId);
  }

  async unlike(reelId: string, userId: string): Promise<number> {
    await this.db.run('DELETE FROM reel_likes WHERE reel_id = ? AND user_id = ?', [reelId, userId]);
    return this.syncLikeCount(reelId);
  }

  async hasLiked(reelId: string, userId: string): Promise<boolean> {
    const row = await this.db.first('SELECT 1 AS x FROM reel_likes WHERE reel_id = ? AND user_id = ?', [
      reelId,
      userId,
    ]);
    return row !== null;
  }

  /**
   * Recount from the join table rather than incrementing a counter: a double
   * click, a retry or a concurrent unlike can never drift the displayed total.
   */
  private async syncLikeCount(reelId: string): Promise<number> {
    await this.db.run(
      `UPDATE reels SET like_count = (SELECT COUNT(*) FROM reel_likes WHERE reel_id = ?), updated_at = ?
       WHERE id = ?`,
      [reelId, now(), reelId],
    );
    const count = await this.db.scalar<number>('SELECT like_count FROM reels WHERE id = ?', [reelId]);
    return count ?? 0;
  }

  async incrementViews(reelId: string): Promise<void> {
    await this.db.run('UPDATE reels SET view_count = view_count + 1 WHERE id = ?', [reelId]);
  }

  /** Soft delete, so moderation keeps an audit trail. */
  async softDelete(reelId: string): Promise<void> {
    await this.db.run(`UPDATE reels SET status = 'deleted', updated_at = ? WHERE id = ?`, [
      now(),
      reelId,
    ]);
  }

  async countForAuthor(authorId: string): Promise<number> {
    const value = await this.db.scalar<number>(
      `SELECT COUNT(*) FROM reels WHERE author_id = ? AND status = 'published'`,
      [authorId],
    );
    return value ?? 0;
  }
}
