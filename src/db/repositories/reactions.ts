/**
 * Reactions and bookmarks.
 *
 * A user has at most one reaction per target (enforced by the primary key on
 * `(user_id, target_type, target_id)`), so "like" then "love" is an update,
 * not a second row. Denormalised counters on posts/comments are updated in the
 * same batch as the reaction row.
 */

import { Db, placeholders } from '../client';
import type { ReactionTargetType, ReactionType } from '../../types/models';
import { newId } from '../../utils/id';
import { now } from '../../utils/time';

export interface ReactionResult {
  /** State after the call: null means the reaction was removed. */
  reaction: ReactionType | null;
  /** Fresh counter for the target. */
  count: number;
  /** True when a *new* reaction was created (used to gate XP and notifications). */
  created: boolean;
}

export class ReactionRepository {
  constructor(private readonly db: Db) {}

  private counterTable(targetType: ReactionTargetType): 'posts' | 'comments' {
    return targetType === 'post' ? 'posts' : 'comments';
  }

  async get(
    userId: string,
    targetType: ReactionTargetType,
    targetId: string,
  ): Promise<ReactionType | null> {
    const row = await this.db.first<{ reaction_type: ReactionType }>(
      'SELECT reaction_type FROM reactions WHERE user_id = ? AND target_type = ? AND target_id = ?',
      [userId, targetType, targetId],
    );
    return row?.reaction_type ?? null;
  }

  /** Viewer reaction state for a page of targets — avoids N+1 in feeds. */
  async getMany(
    userId: string,
    targetType: ReactionTargetType,
    targetIds: string[],
  ): Promise<Map<string, ReactionType>> {
    const out = new Map<string, ReactionType>();
    if (!userId || !targetIds.length) return out;
    const unique = [...new Set(targetIds)];
    const rows = await this.db.all<{ target_id: string; reaction_type: ReactionType }>(
      `SELECT target_id, reaction_type FROM reactions
       WHERE user_id = ? AND target_type = ? AND target_id IN (${placeholders(unique.length)})`,
      [userId, targetType, ...unique],
    );
    for (const row of rows) out.set(row.target_id, row.reaction_type);
    return out;
  }

  /**
   * Toggle semantics:
   *   none      + X → set X   (count +1, created)
   *   X         + X → remove  (count -1)
   *   X         + Y → switch  (count unchanged)
   */
  async toggle(input: {
    userId: string;
    targetType: ReactionTargetType;
    targetId: string;
    reaction: ReactionType;
  }): Promise<ReactionResult> {
    const { userId, targetType, targetId, reaction } = input;
    const table = this.counterTable(targetType);
    const existing = await this.get(userId, targetType, targetId);
    const ts = now();

    if (existing === reaction) {
      await this.db.batch([
        {
          sql: 'DELETE FROM reactions WHERE user_id = ? AND target_type = ? AND target_id = ?',
          params: [userId, targetType, targetId],
        },
        {
          sql: `UPDATE ${table} SET reaction_count = MAX(0, reaction_count - 1) WHERE id = ?`,
          params: [targetId],
        },
      ]);
      return { reaction: null, count: await this.count(targetType, targetId), created: false };
    }

    if (existing) {
      await this.db.run(
        `UPDATE reactions SET reaction_type = ?, created_at = ?
         WHERE user_id = ? AND target_type = ? AND target_id = ?`,
        [reaction, ts, userId, targetType, targetId],
      );
      return { reaction, count: await this.count(targetType, targetId), created: false };
    }

    await this.db.batch([
      {
        sql: `INSERT INTO reactions (id, user_id, target_type, target_id, reaction_type, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        params: [newId('rct'), userId, targetType, targetId, reaction, ts],
      },
      {
        sql: `UPDATE ${table} SET reaction_count = reaction_count + 1 WHERE id = ?`,
        params: [targetId],
      },
    ]);
    return { reaction, count: await this.count(targetType, targetId), created: true };
  }

  async count(targetType: ReactionTargetType, targetId: string): Promise<number> {
    const table = this.counterTable(targetType);
    return (
      (await this.db.scalar<number>(`SELECT reaction_count FROM ${table} WHERE id = ?`, [
        targetId,
      ])) ?? 0
    );
  }

  /** Breakdown by reaction type, for the reaction tooltip. */
  async breakdown(
    targetType: ReactionTargetType,
    targetId: string,
  ): Promise<Record<string, number>> {
    const rows = await this.db.all<{ reaction_type: string; n: number }>(
      `SELECT reaction_type, COUNT(*) AS n FROM reactions
       WHERE target_type = ? AND target_id = ? GROUP BY reaction_type`,
      [targetType, targetId],
    );
    const out: Record<string, number> = {};
    for (const row of rows) out[row.reaction_type] = row.n;
    return out;
  }

  /** Recompute a counter from the source rows (used by the nightly cron). */
  async reconcile(targetType: ReactionTargetType, targetId: string): Promise<void> {
    const table = this.counterTable(targetType);
    await this.db.run(
      `UPDATE ${table} SET reaction_count = (
         SELECT COUNT(*) FROM reactions WHERE target_type = ? AND target_id = ?
       ) WHERE id = ?`,
      [targetType, targetId, targetId],
    );
  }
}

export class BookmarkRepository {
  constructor(private readonly db: Db) {}

  async has(userId: string, postId: string): Promise<boolean> {
    const row = await this.db.first('SELECT 1 AS x FROM bookmarks WHERE user_id = ? AND post_id = ?', [
      userId,
      postId,
    ]);
    return row !== null;
  }

  async getMany(userId: string, postIds: string[]): Promise<Set<string>> {
    if (!userId || !postIds.length) return new Set();
    const unique = [...new Set(postIds)];
    const rows = await this.db.all<{ post_id: string }>(
      `SELECT post_id FROM bookmarks WHERE user_id = ? AND post_id IN (${placeholders(unique.length)})`,
      [userId, ...unique],
    );
    return new Set(rows.map((r) => r.post_id));
  }

  async toggle(userId: string, postId: string): Promise<{ bookmarked: boolean; count: number }> {
    const exists = await this.has(userId, postId);
    if (exists) {
      await this.db.batch([
        { sql: 'DELETE FROM bookmarks WHERE user_id = ? AND post_id = ?', params: [userId, postId] },
        {
          sql: 'UPDATE posts SET bookmark_count = MAX(0, bookmark_count - 1) WHERE id = ?',
          params: [postId],
        },
      ]);
    } else {
      await this.db.batch([
        {
          sql: 'INSERT OR IGNORE INTO bookmarks (user_id, post_id, created_at) VALUES (?, ?, ?)',
          params: [userId, postId, now()],
        },
        { sql: 'UPDATE posts SET bookmark_count = bookmark_count + 1 WHERE id = ?', params: [postId] },
      ]);
    }
    const count =
      (await this.db.scalar<number>('SELECT bookmark_count FROM posts WHERE id = ?', [postId])) ?? 0;
    return { bookmarked: !exists, count };
  }
}
