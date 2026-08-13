/**
 * Moderation repository: reports, the append-only audit log, and the
 * aggregates the admin dashboard renders.
 */

import { Db } from '../client';
import type { ReportReason, ReportRow, ReportStatus, ReportTargetType } from '../../types/models';
import { newId } from '../../utils/id';
import { dayKey, now } from '../../utils/time';
import type { Cursor } from '../../utils/cursor';

export interface ReportWithContext extends ReportRow {
  reporter_username: string;
  reviewer_username: string | null;
}

export class ReportRepository {
  constructor(private readonly db: Db) {}

  /**
   * Create a report. The partial unique index means a second open report from
   * the same user for the same target is rejected by the database; we surface
   * that as "already reported" rather than an error.
   */
  async create(input: {
    reporterId: string;
    targetType: ReportTargetType;
    targetId: string;
    reason: ReportReason;
    description: string;
  }): Promise<{ id: string; duplicate: boolean }> {
    const existing = await this.db.first<{ id: string }>(
      `SELECT id FROM reports
       WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status IN ('open', 'reviewing')`,
      [input.reporterId, input.targetType, input.targetId],
    );
    if (existing) return { id: existing.id, duplicate: true };

    const id = newId('rpt');
    await this.db.run(
      `INSERT INTO reports (id, reporter_id, target_type, target_id, reason, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.reporterId,
        input.targetType,
        input.targetId,
        input.reason,
        input.description,
        now(),
      ],
    );
    return { id, duplicate: false };
  }

  async findById(id: string): Promise<ReportWithContext | null> {
    return this.db.first<ReportWithContext>(
      `SELECT r.*, ru.username AS reporter_username, mu.username AS reviewer_username
       FROM reports r
       JOIN users ru ON ru.id = r.reporter_id
       LEFT JOIN users mu ON mu.id = r.reviewed_by
       WHERE r.id = ?`,
      [id],
    );
  }

  async list(options: {
    cursor: Cursor | null;
    limit: number;
    status?: ReportStatus;
    targetType?: ReportTargetType;
  }): Promise<ReportWithContext[]> {
    const where: string[] = ['1 = 1'];
    const params: (string | number)[] = [];

    if (options.status) {
      where.push('r.status = ?');
      params.push(options.status);
    }
    if (options.targetType) {
      where.push('r.target_type = ?');
      params.push(options.targetType);
    }
    if (options.cursor) {
      where.push('(r.created_at < ? OR (r.created_at = ? AND r.id < ?))');
      params.push(options.cursor.v, options.cursor.v, options.cursor.i);
    }

    return this.db.all<ReportWithContext>(
      `SELECT r.*, ru.username AS reporter_username, mu.username AS reviewer_username
       FROM reports r
       JOIN users ru ON ru.id = r.reporter_id
       LEFT JOIN users mu ON mu.id = r.reviewed_by
       WHERE ${where.join(' AND ')}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT ?`,
      [...params, options.limit + 1],
    );
  }

  async resolve(input: {
    id: string;
    status: ReportStatus;
    resolution: string;
    reviewerId: string;
  }): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE reports SET status = ?, resolution = ?, reviewed_by = ?, reviewed_at = ?
       WHERE id = ? AND status IN ('open', 'reviewing')`,
      [input.status, input.resolution, input.reviewerId, now(), input.id],
    );
    return result.changes > 0;
  }

  /** Resolve every open report pointing at a target (after a moderation action). */
  async resolveForTarget(
    targetType: ReportTargetType,
    targetId: string,
    reviewerId: string,
    resolution: string,
  ): Promise<number> {
    const result = await this.db.run(
      `UPDATE reports SET status = 'resolved', resolution = ?, reviewed_by = ?, reviewed_at = ?
       WHERE target_type = ? AND target_id = ? AND status IN ('open', 'reviewing')`,
      [resolution, reviewerId, now(), targetType, targetId],
    );
    return result.changes;
  }

  async countOpen(): Promise<number> {
    return (
      (await this.db.scalar<number>(
        `SELECT COUNT(*) FROM reports WHERE status IN ('open', 'reviewing')`,
      )) ?? 0
    );
  }

  async countForTarget(targetType: ReportTargetType, targetId: string): Promise<number> {
    return (
      (await this.db.scalar<number>(
        'SELECT COUNT(*) FROM reports WHERE target_type = ? AND target_id = ?',
        [targetType, targetId],
      )) ?? 0
    );
  }
}

export interface AuditEntry {
  actorId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ipHash?: string;
}

export class AuditRepository {
  constructor(private readonly db: Db) {}

  /**
   * Append-only. Every privileged action calls this; the metadata blob must
   * never contain secrets (callers pass ids and reasons, not tokens).
   */
  async log(entry: AuditEntry): Promise<string> {
    const id = newId('aud');
    await this.db.run(
      `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, metadata_json, ip_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        entry.actorId,
        entry.action,
        entry.targetType ?? '',
        entry.targetId ?? '',
        JSON.stringify(entry.metadata ?? {}),
        entry.ipHash ?? '',
        now(),
      ],
    );
    return id;
  }

  async list(options: {
    cursor: Cursor | null;
    limit: number;
    actorId?: string;
    action?: string;
    targetId?: string;
  }) {
    const where: string[] = ['1 = 1'];
    const params: (string | number)[] = [];

    if (options.actorId) {
      where.push('a.actor_id = ?');
      params.push(options.actorId);
    }
    if (options.action) {
      where.push('a.action = ?');
      params.push(options.action);
    }
    if (options.targetId) {
      where.push('a.target_id = ?');
      params.push(options.targetId);
    }
    if (options.cursor) {
      where.push('(a.created_at < ? OR (a.created_at = ? AND a.id < ?))');
      params.push(options.cursor.v, options.cursor.v, options.cursor.i);
    }

    return this.db.all<{
      id: string;
      actor_id: string | null;
      actor_username: string | null;
      action: string;
      target_type: string;
      target_id: string;
      metadata_json: string;
      created_at: number;
    }>(
      `SELECT a.id, a.actor_id, u.username AS actor_username, a.action,
              a.target_type, a.target_id, a.metadata_json, a.created_at
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ?`,
      [...params, options.limit + 1],
    );
  }
}

export interface DashboardStats {
  users: number;
  activeUsers: number;
  suspendedUsers: number;
  posts: number;
  publishedPosts: number;
  hiddenPosts: number;
  comments: number;
  reactions: number;
  media: number;
  mediaBytes: number;
  openReports: number;
  activeSessions: number;
  newUsers24h: number;
  newPosts24h: number;
}

export class StatsRepository {
  constructor(private readonly db: Db) {}

  /** One batch instead of a dozen sequential round trips. */
  async dashboard(): Promise<DashboardStats> {
    const since = now() - 86400;
    const results = await this.db.batch<{ n: number }>([
      { sql: 'SELECT COUNT(*) AS n FROM users', params: [] },
      { sql: `SELECT COUNT(*) AS n FROM users WHERE status = 'active'`, params: [] },
      { sql: `SELECT COUNT(*) AS n FROM users WHERE status IN ('suspended', 'banned')`, params: [] },
      { sql: 'SELECT COUNT(*) AS n FROM posts', params: [] },
      { sql: `SELECT COUNT(*) AS n FROM posts WHERE status = 'published'`, params: [] },
      { sql: `SELECT COUNT(*) AS n FROM posts WHERE status = 'hidden'`, params: [] },
      { sql: `SELECT COUNT(*) AS n FROM comments WHERE status = 'published'`, params: [] },
      { sql: 'SELECT COUNT(*) AS n FROM reactions', params: [] },
      { sql: `SELECT COUNT(*) AS n FROM media WHERE status = 'ready'`, params: [] },
      { sql: `SELECT COALESCE(SUM(size), 0) AS n FROM media WHERE status = 'ready'`, params: [] },
      { sql: `SELECT COUNT(*) AS n FROM reports WHERE status IN ('open', 'reviewing')`, params: [] },
      {
        sql: 'SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?',
        params: [now()],
      },
      { sql: 'SELECT COUNT(*) AS n FROM users WHERE created_at > ?', params: [since] },
      { sql: 'SELECT COUNT(*) AS n FROM posts WHERE created_at > ?', params: [since] },
    ]);

    const at = (index: number): number => results[index]?.results?.[0]?.n ?? 0;

    return {
      users: at(0),
      activeUsers: at(1),
      suspendedUsers: at(2),
      posts: at(3),
      publishedPosts: at(4),
      hiddenPosts: at(5),
      comments: at(6),
      reactions: at(7),
      media: at(8),
      mediaBytes: at(9),
      openReports: at(10),
      activeSessions: at(11),
      newUsers24h: at(12),
      newPosts24h: at(13),
    };
  }

  /** Nightly rollup for the given day (defaults to the previous 24h window). */
  async aggregateDay(dayStart: number): Promise<void> {
    const dayEnd = dayStart + 86400;
    const day = dayKey(dayStart);

    const results = await this.db.batch<{ n: number }>([
      {
        sql: 'SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?',
        params: [dayStart, dayEnd],
      },
      {
        sql: 'SELECT COUNT(*) AS n FROM posts WHERE created_at >= ? AND created_at < ?',
        params: [dayStart, dayEnd],
      },
      {
        sql: 'SELECT COUNT(*) AS n FROM comments WHERE created_at >= ? AND created_at < ?',
        params: [dayStart, dayEnd],
      },
      {
        sql: 'SELECT COUNT(*) AS n FROM reactions WHERE created_at >= ? AND created_at < ?',
        params: [dayStart, dayEnd],
      },
      {
        sql: 'SELECT COUNT(*) AS n FROM users WHERE last_seen_at >= ? AND last_seen_at < ?',
        params: [dayStart, dayEnd],
      },
      {
        sql: `SELECT COALESCE(SUM(size), 0) AS n FROM media WHERE status = 'ready'`,
        params: [],
      },
    ]);
    const at = (index: number): number => results[index]?.results?.[0]?.n ?? 0;

    await this.db.run(
      `INSERT INTO stats_daily (day, new_users, new_posts, new_comments, new_reactions, active_users, media_bytes, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (day) DO UPDATE SET
         new_users = excluded.new_users,
         new_posts = excluded.new_posts,
         new_comments = excluded.new_comments,
         new_reactions = excluded.new_reactions,
         active_users = excluded.active_users,
         media_bytes = excluded.media_bytes,
         computed_at = excluded.computed_at`,
      [day, at(0), at(1), at(2), at(3), at(4), at(5), now()],
    );
  }

  async recentDays(limit = 30) {
    return this.db.all<{
      day: string;
      new_users: number;
      new_posts: number;
      new_comments: number;
      new_reactions: number;
      active_users: number;
      media_bytes: number;
    }>(
      `SELECT day, new_users, new_posts, new_comments, new_reactions, active_users, media_bytes
       FROM stats_daily ORDER BY day DESC LIMIT ?`,
      [limit],
    );
  }
}
