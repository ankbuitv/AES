/**
 * Notification repository.
 *
 * The unique dedupe index from migration 0006 lets us use INSERT OR REPLACE
 * semantics for repeatable events (like → unlike → like) without accumulating
 * duplicate rows in the recipient's inbox.
 */

import { Db, placeholders } from '../client';
import type { NotificationRow, NotificationType } from '../../types/models';
import { newId } from '../../utils/id';
import { now } from '../../utils/time';
import type { Cursor } from '../../utils/cursor';

export interface NotificationWithActor extends NotificationRow {
  actor_username: string | null;
  actor_display_name: string | null;
  actor_avatar_media_id: string | null;
}

export interface CreateNotification {
  userId: string;
  actorId: string | null;
  type: NotificationType;
  targetType: string;
  targetId: string;
  data?: Record<string, unknown>;
}

export class NotificationRepository {
  constructor(private readonly db: Db) {}

  /**
   * Never notify a user about their own action, and collapse repeats.
   * Returns false when nothing was inserted.
   */
  async create(input: CreateNotification): Promise<boolean> {
    if (input.actorId && input.actorId === input.userId) return false;

    const ts = now();
    const result = await this.db.run(
      `INSERT INTO notifications
         (id, user_id, actor_id, type, target_type, target_id, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, actor_id, type, target_type, target_id)
         WHERE target_id <> '' AND actor_id IS NOT NULL
         DO UPDATE SET created_at = excluded.created_at,
                       data_json  = excluded.data_json,
                       read_at    = NULL`,
      [
        newId('ntf'),
        input.userId,
        input.actorId,
        input.type,
        input.targetType,
        input.targetId,
        JSON.stringify(input.data ?? {}),
        ts,
      ],
    );
    return result.changes > 0;
  }

  /** Fan-out helper: one batch instead of N round trips. */
  async createMany(items: CreateNotification[]): Promise<number> {
    const filtered = items.filter((item) => item.actorId !== item.userId);
    if (!filtered.length) return 0;

    const ts = now();
    await this.db.batch(
      filtered.map((input) => ({
        sql: `INSERT INTO notifications
                (id, user_id, actor_id, type, target_type, target_id, data_json, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (user_id, actor_id, type, target_type, target_id)
                WHERE target_id <> '' AND actor_id IS NOT NULL
                DO UPDATE SET created_at = excluded.created_at, read_at = NULL`,
        params: [
          newId('ntf'),
          input.userId,
          input.actorId,
          input.type,
          input.targetType,
          input.targetId,
          JSON.stringify(input.data ?? {}),
          ts,
        ] as (string | number | null)[],
      })),
    );
    return filtered.length;
  }

  /** Remove a notification when the action that caused it is undone. */
  async removeFor(input: {
    userId: string;
    actorId: string;
    type: NotificationType;
    targetType: string;
    targetId: string;
  }): Promise<void> {
    await this.db.run(
      `DELETE FROM notifications
       WHERE user_id = ? AND actor_id = ? AND type = ? AND target_type = ? AND target_id = ?`,
      [input.userId, input.actorId, input.type, input.targetType, input.targetId],
    );
  }

  async list(options: {
    userId: string;
    cursor: Cursor | null;
    limit: number;
    unreadOnly?: boolean;
  }): Promise<NotificationWithActor[]> {
    const where = ['n.user_id = ?'];
    const params: (string | number)[] = [options.userId];

    if (options.unreadOnly) where.push('n.read_at IS NULL');
    if (options.cursor) {
      where.push('(n.created_at < ? OR (n.created_at = ? AND n.id < ?))');
      params.push(options.cursor.v, options.cursor.v, options.cursor.i);
    }

    return this.db.all<NotificationWithActor>(
      `SELECT n.*,
              a.username        AS actor_username,
              a.display_name    AS actor_display_name,
              a.avatar_media_id AS actor_avatar_media_id
       FROM notifications n
       LEFT JOIN users a ON a.id = n.actor_id
       WHERE ${where.join(' AND ')}
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT ?`,
      [...params, options.limit + 1],
    );
  }

  async unreadCount(userId: string): Promise<number> {
    return (
      (await this.db.scalar<number>(
        'SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL',
        [userId],
      )) ?? 0
    );
  }

  async markRead(userId: string, ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const result = await this.db.run(
      `UPDATE notifications SET read_at = ?
       WHERE user_id = ? AND read_at IS NULL AND id IN (${placeholders(ids.length)})`,
      [now(), userId, ...ids],
    );
    return result.changes;
  }

  async markAllRead(userId: string): Promise<number> {
    const result = await this.db.run(
      'UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL',
      [now(), userId],
    );
    return result.changes;
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const result = await this.db.run('DELETE FROM notifications WHERE user_id = ? AND id = ?', [
      userId,
      id,
    ]);
    return result.changes > 0;
  }

  /** Cron: keep the table bounded. */
  async purgeOld(olderThan: number, limit = 2000): Promise<number> {
    const result = await this.db.run(
      `DELETE FROM notifications WHERE id IN (
         SELECT id FROM notifications WHERE created_at < ? AND read_at IS NOT NULL LIMIT ?
       )`,
      [olderThan, limit],
    );
    return result.changes;
  }
}

/** Durable fallback job queue (used when Cloudflare Queues is not bound). */
export class JobRepository {
  constructor(private readonly db: Db) {}

  async enqueue(type: string, payload: Record<string, unknown>, delaySeconds = 0): Promise<string> {
    const id = newId('job');
    const ts = now();
    await this.db.run(
      `INSERT INTO jobs (id, type, payload_json, status, run_after, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      [id, type, JSON.stringify(payload), ts + delaySeconds, ts, ts],
    );
    return id;
  }

  async takeBatch(limit = 20) {
    const ts = now();
    const rows = await this.db.all<{
      id: string;
      type: string;
      payload_json: string;
      attempts: number;
    }>(
      `SELECT id, type, payload_json, attempts FROM jobs
       WHERE status = 'pending' AND run_after <= ?
       ORDER BY run_after ASC LIMIT ?`,
      [ts, limit],
    );
    if (!rows.length) return rows;

    // Claim them so a concurrent cron invocation does not double-process.
    await this.db.run(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
       WHERE id IN (${placeholders(rows.length)}) AND status = 'pending'`,
      [ts, ...rows.map((r) => r.id)],
    );
    return rows;
  }

  async complete(id: string): Promise<void> {
    await this.db.run(`UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?`, [now(), id]);
  }

  async fail(id: string, error: string, attempts: number): Promise<void> {
    const ts = now();
    // Exponential backoff, five attempts, then park as failed.
    const status = attempts >= 5 ? 'failed' : 'pending';
    await this.db.run(
      `UPDATE jobs SET status = ?, last_error = ?, run_after = ?, updated_at = ? WHERE id = ?`,
      [status, error.slice(0, 300), ts + Math.min(3600, 30 * 2 ** attempts), ts, id],
    );
  }

  async purgeDone(olderThan: number): Promise<number> {
    const result = await this.db.run(
      `DELETE FROM jobs WHERE status = 'done' AND updated_at < ?`,
      [olderThan],
    );
    return result.changes;
  }
}
