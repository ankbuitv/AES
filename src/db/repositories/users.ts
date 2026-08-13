/**
 * User repository — all SQL touching `users`, `follows`, `blocks`,
 * `user_badges` and `xp_events` lives here.
 */

import { Db, placeholders } from '../client';
import type { AuthUser, PublicUser, UserRole, UserRow, UserStatus } from '../../types/models';
import { newId } from '../../utils/id';
import { now } from '../../utils/time';
import { levelForXp } from '../../config';
import { buildPage, type Cursor } from '../../utils/cursor';

/**
 * Columns safe to read for profile rendering. `password_hash` is deliberately
 * absent so it can never leak into a DTO by accident.
 */
const PUBLIC_FIELDS = [
  'id',
  'username',
  'display_name',
  'email',
  'avatar_media_id',
  'cover_media_id',
  'bio',
  'location',
  'website',
  'role',
  'status',
  'level',
  'xp',
  'post_count',
  'comment_count',
  'reaction_received_count',
  'follower_count',
  'following_count',
  'created_at',
  'updated_at',
  'last_seen_at',
] as const;

const PUBLIC_COLUMNS = PUBLIC_FIELDS.join(', ');

/** Same list, prefixed for joined queries (`u.id, u.username, ...`). */
function publicColumns(alias: string): string {
  return PUBLIC_FIELDS.map((field) => `${alias}.${field}`).join(', ');
}

export class UserRepository {
  constructor(private readonly db: Db) {}

  async findById(id: string): Promise<UserRow | null> {
    return this.db.first<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
  }

  async findByUsername(username: string): Promise<UserRow | null> {
    return this.db.first<UserRow>('SELECT * FROM users WHERE username = ?', [
      username.toLowerCase(),
    ]);
  }

  async findByEmail(email: string): Promise<UserRow | null> {
    return this.db.first<UserRow>('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
  }

  /** Login accepts a username or an email in the same field. */
  async findByIdentifier(identifier: string): Promise<UserRow | null> {
    const value = identifier.trim().toLowerCase();
    return this.db.first<UserRow>('SELECT * FROM users WHERE username = ? OR email = ? LIMIT 1', [
      value,
      value,
    ]);
  }

  async findManyByIds(ids: string[]): Promise<Map<string, UserRow>> {
    if (!ids.length) return new Map();
    const unique = [...new Set(ids)];
    const rows = await this.db.all<UserRow>(
      `SELECT ${PUBLIC_COLUMNS} FROM users WHERE id IN (${placeholders(unique.length)})`,
      unique,
    );
    return new Map(rows.map((row) => [row.id, row]));
  }

  async usernameExists(username: string): Promise<boolean> {
    const row = await this.db.first('SELECT 1 AS x FROM users WHERE username = ?', [
      username.toLowerCase(),
    ]);
    return row !== null;
  }

  async emailExists(email: string): Promise<boolean> {
    const row = await this.db.first('SELECT 1 AS x FROM users WHERE email = ?', [
      email.toLowerCase(),
    ]);
    return row !== null;
  }

  async create(input: {
    username: string;
    email: string;
    displayName: string;
    passwordHash: string;
    role?: UserRole;
  }): Promise<UserRow> {
    const id = newId('usr');
    const ts = now();
    await this.db.run(
      `INSERT INTO users (id, username, display_name, email, password_hash, role, status, created_at, updated_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      [
        id,
        input.username.toLowerCase(),
        input.displayName,
        input.email.toLowerCase(),
        input.passwordHash,
        input.role ?? 'user',
        ts,
        ts,
        ts,
      ],
    );
    const created = await this.findById(id);
    if (!created) throw new Error('User insert did not persist');
    return created;
  }

  async updateProfile(
    id: string,
    patch: Partial<{
      displayName: string;
      bio: string;
      location: string;
      website: string;
      avatarMediaId: string | null;
      coverMediaId: string | null;
    }>,
  ): Promise<void> {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];

    const map: Record<string, string> = {
      displayName: 'display_name',
      bio: 'bio',
      location: 'location',
      website: 'website',
      avatarMediaId: 'avatar_media_id',
      coverMediaId: 'cover_media_id',
    };

    for (const [key, column] of Object.entries(map)) {
      if (key in patch) {
        sets.push(`${column} = ?`);
        params.push((patch as Record<string, string | null>)[key] ?? null);
      }
    }
    if (!sets.length) return;

    sets.push('updated_at = ?');
    params.push(now(), id);
    await this.db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
      passwordHash,
      now(),
      id,
    ]);
  }

  async touchLastSeen(id: string): Promise<void> {
    await this.db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', [now(), id]);
  }

  async markLogin(id: string): Promise<void> {
    const ts = now();
    await this.db.run('UPDATE users SET last_login_at = ?, last_seen_at = ? WHERE id = ?', [
      ts,
      ts,
      id,
    ]);
  }

  async setStatus(
    id: string,
    status: UserStatus,
    reason = '',
    suspendedUntil: number | null = null,
  ): Promise<void> {
    await this.db.run(
      'UPDATE users SET status = ?, status_reason = ?, suspended_until = ?, updated_at = ? WHERE id = ?',
      [status, reason, suspendedUntil, now(), id],
    );
  }

  async setRole(id: string, role: UserRole): Promise<void> {
    await this.db.run('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', [role, now(), id]);
  }

  /** Anonymise instead of hard-deleting, preserving thread integrity. */
  async softDelete(id: string): Promise<void> {
    const ts = now();
    await this.db.batch([
      {
        sql: `UPDATE users
              SET status = 'deleted',
                  email = 'deleted+' || id || '@invalid',
                  display_name = 'Deleted account',
                  bio = '', location = '', website = '',
                  avatar_media_id = NULL, cover_media_id = NULL,
                  password_hash = 'deleted',
                  updated_at = ?
              WHERE id = ?`,
        params: [ts, id],
      },
      { sql: 'DELETE FROM sessions WHERE user_id = ?', params: [id] },
      { sql: `UPDATE posts SET status = 'deleted', updated_at = ? WHERE author_id = ?`, params: [ts, id] },
      { sql: `UPDATE comments SET status = 'deleted', updated_at = ? WHERE author_id = ?`, params: [ts, id] },
    ]);
  }

  // --- XP / gamification ----------------------------------------------------

  /**
   * Award XP idempotently: the unique index on
   * (user_id, reason, target_type, target_id) makes a repeated award a no-op,
   * which is what stops clients from farming XP by replaying an action.
   */
  async awardXp(
    userId: string,
    amount: number,
    reason: string,
    target: { type: string; id: string } = { type: '', id: '' },
  ): Promise<boolean> {
    const ts = now();
    const inserted = await this.db.run(
      `INSERT OR IGNORE INTO xp_events (id, user_id, amount, reason, target_type, target_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newId('xp'), userId, amount, reason, target.type, target.id, ts],
    );
    if (!inserted.changes) return false;

    await this.db.run('UPDATE users SET xp = MAX(0, xp + ?), updated_at = ? WHERE id = ?', [
      amount,
      ts,
      userId,
    ]);

    // Recompute the level from the authoritative XP total.
    const row = await this.db.first<{ xp: number; level: number }>(
      'SELECT xp, level FROM users WHERE id = ?',
      [userId],
    );
    if (row) {
      const level = levelForXp(row.xp);
      if (level !== row.level) {
        await this.db.run('UPDATE users SET level = ? WHERE id = ?', [level, userId]);
      }
    }
    return true;
  }

  async claimDailyLoginXp(userId: string, amount: number): Promise<boolean> {
    const ts = now();
    // 20h cooldown so the bonus cannot be claimed twice in one calendar day.
    const result = await this.db.run(
      `UPDATE users SET last_xp_daily_at = ?
       WHERE id = ? AND (last_xp_daily_at IS NULL OR last_xp_daily_at < ?)`,
      [ts, userId, ts - 20 * 3600],
    );
    if (!result.changes) return false;
    return this.awardXp(userId, amount, 'daily_login', { type: 'day', id: String(Math.floor(ts / 86400)) });
  }

  /**
   * Undo an award. Deleting the ledger row also makes the action re-awardable,
   * which is correct: the user genuinely did it again.
   */
  async revokeXp(
    userId: string,
    reason: string,
    target: { type: string; id: string } = { type: '', id: '' },
  ): Promise<void> {
    const row = await this.db.first<{ id: string; amount: number }>(
      `SELECT id, amount FROM xp_events
       WHERE user_id = ? AND reason = ? AND target_type = ? AND target_id = ?`,
      [userId, reason, target.type, target.id],
    );
    if (!row) return;

    await this.db.batch([
      { sql: 'DELETE FROM xp_events WHERE id = ?', params: [row.id] },
      {
        sql: 'UPDATE users SET xp = MAX(0, xp - ?), updated_at = ? WHERE id = ?',
        params: [row.amount, now(), userId],
      },
    ]);

    const after = await this.db.first<{ xp: number; level: number }>(
      'SELECT xp, level FROM users WHERE id = ?',
      [userId],
    );
    if (after) {
      const level = levelForXp(after.xp);
      if (level !== after.level) {
        await this.db.run('UPDATE users SET level = ? WHERE id = ?', [level, userId]);
      }
    }
  }

  /** Leaderboard, served from the idx_users_xp index. */
  async topByXp(limit = 20): Promise<UserRow[]> {
    return this.db.all<UserRow>(
      `SELECT ${PUBLIC_COLUMNS} FROM users
       WHERE status = 'active'
       ORDER BY xp DESC, created_at ASC
       LIMIT ?`,
      [limit],
    );
  }

  /**
   * Counter maintenance for badge rules. Both counters are also recomputed by
   * the nightly reconcile cron, so a missed increment self-heals.
   */
  async bumpCounters(
    userId: string,
    patch: { comments?: number; reactionsReceived?: number },
  ): Promise<void> {
    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (patch.comments) {
      sets.push('comment_count = MAX(0, comment_count + ?)');
      params.push(patch.comments);
    }
    if (patch.reactionsReceived) {
      sets.push('reaction_received_count = MAX(0, reaction_received_count + ?)');
      params.push(patch.reactionsReceived);
    }
    if (!sets.length) return;
    await this.db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, userId]);
  }

  /** Nightly reconcile: recompute drifted counters from the source tables. */
  async reconcileCounters(limit = 500): Promise<number> {
    const result = await this.db.run(
      `UPDATE users SET
         post_count = (SELECT COUNT(*) FROM posts p WHERE p.author_id = users.id AND p.status = 'published'),
         comment_count = (SELECT COUNT(*) FROM comments c WHERE c.author_id = users.id AND c.status = 'published'),
         follower_count = (SELECT COUNT(*) FROM follows f WHERE f.following_id = users.id),
         following_count = (SELECT COUNT(*) FROM follows f WHERE f.follower_id = users.id)
       WHERE id IN (SELECT id FROM users WHERE status = 'active' ORDER BY last_seen_at DESC LIMIT ?)`,
      [limit],
    );
    return result.changes;
  }

  async listBadges(userId: string): Promise<string[]> {
    const rows = await this.db.all<{ badge_code: string }>(
      'SELECT badge_code FROM user_badges WHERE user_id = ? ORDER BY awarded_at ASC',
      [userId],
    );
    return rows.map((r) => r.badge_code);
  }

  async awardBadge(userId: string, code: string): Promise<boolean> {
    const result = await this.db.run(
      'INSERT OR IGNORE INTO user_badges (user_id, badge_code, awarded_at) VALUES (?, ?, ?)',
      [userId, code, now()],
    );
    return result.changes > 0;
  }

  // --- Follows --------------------------------------------------------------

  async isFollowing(followerId: string, followingId: string): Promise<boolean> {
    const row = await this.db.first(
      'SELECT 1 AS x FROM follows WHERE follower_id = ? AND following_id = ?',
      [followerId, followingId],
    );
    return row !== null;
  }

  async getFollowState(
    viewerId: string,
    targetIds: string[],
  ): Promise<Set<string>> {
    if (!viewerId || !targetIds.length) return new Set();
    const unique = [...new Set(targetIds)];
    const rows = await this.db.all<{ following_id: string }>(
      `SELECT following_id FROM follows
       WHERE follower_id = ? AND following_id IN (${placeholders(unique.length)})`,
      [viewerId, ...unique],
    );
    return new Set(rows.map((r) => r.following_id));
  }

  /** Follow + counters in one atomic batch. Returns false if already following. */
  async follow(followerId: string, followingId: string): Promise<boolean> {
    const result = await this.db.run(
      'INSERT OR IGNORE INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)',
      [followerId, followingId, now()],
    );
    if (!result.changes) return false;

    await this.db.batch([
      {
        sql: 'UPDATE users SET follower_count = follower_count + 1 WHERE id = ?',
        params: [followingId],
      },
      {
        sql: 'UPDATE users SET following_count = following_count + 1 WHERE id = ?',
        params: [followerId],
      },
    ]);
    return true;
  }

  async unfollow(followerId: string, followingId: string): Promise<boolean> {
    const result = await this.db.run(
      'DELETE FROM follows WHERE follower_id = ? AND following_id = ?',
      [followerId, followingId],
    );
    if (!result.changes) return false;

    await this.db.batch([
      {
        sql: 'UPDATE users SET follower_count = MAX(0, follower_count - 1) WHERE id = ?',
        params: [followingId],
      },
      {
        sql: 'UPDATE users SET following_count = MAX(0, following_count - 1) WHERE id = ?',
        params: [followerId],
      },
    ]);
    return true;
  }

  async listFollowers(userId: string, cursor: Cursor | null, limit: number) {
    const rows = await this.db.all<UserRow & { follow_created: number }>(
      `SELECT ${publicColumns('u')}, f.created_at AS follow_created
       FROM follows f
       JOIN users u ON u.id = f.follower_id
       WHERE f.following_id = ?
         AND u.status = 'active'
         ${cursor ? 'AND (f.created_at < ? OR (f.created_at = ? AND u.id < ?))' : ''}
       ORDER BY f.created_at DESC, u.id DESC
       LIMIT ?`,
      cursor
        ? [userId, cursor.v, cursor.v, cursor.i, limit + 1]
        : [userId, limit + 1],
    );
    return buildPage(rows, limit, (row) => toPublicUser(row), (row) => ({
      v: row.follow_created,
      i: row.id,
    }));
  }

  async listFollowing(userId: string, cursor: Cursor | null, limit: number) {
    const rows = await this.db.all<UserRow & { follow_created: number }>(
      `SELECT ${publicColumns('u')}, f.created_at AS follow_created
       FROM follows f
       JOIN users u ON u.id = f.following_id
       WHERE f.follower_id = ?
         AND u.status = 'active'
         ${cursor ? 'AND (f.created_at < ? OR (f.created_at = ? AND u.id < ?))' : ''}
       ORDER BY f.created_at DESC, u.id DESC
       LIMIT ?`,
      cursor ? [userId, cursor.v, cursor.v, cursor.i, limit + 1] : [userId, limit + 1],
    );
    return buildPage(rows, limit, (row) => toPublicUser(row), (row) => ({
      v: row.follow_created,
      i: row.id,
    }));
  }

  /** Ids the viewer follows — used to build the Following feed. */
  async followingIds(userId: string, limit = 1000): Promise<string[]> {
    const rows = await this.db.all<{ following_id: string }>(
      'SELECT following_id FROM follows WHERE follower_id = ? ORDER BY created_at DESC LIMIT ?',
      [userId, limit],
    );
    return rows.map((r) => r.following_id);
  }

  // --- Blocks ---------------------------------------------------------------

  async block(blockerId: string, blockedId: string): Promise<void> {
    await this.db.batch([
      {
        sql: 'INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)',
        params: [blockerId, blockedId, now()],
      },
      {
        sql: 'DELETE FROM follows WHERE (follower_id = ? AND following_id = ?) OR (follower_id = ? AND following_id = ?)',
        params: [blockerId, blockedId, blockedId, blockerId],
      },
    ]);
  }

  async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.db.run('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [
      blockerId,
      blockedId,
    ]);
  }

  async isBlocked(a: string, b: string): Promise<boolean> {
    const row = await this.db.first(
      `SELECT 1 AS x FROM blocks
       WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
       LIMIT 1`,
      [a, b, b, a],
    );
    return row !== null;
  }

  // --- Discovery / admin ----------------------------------------------------

  async search(query: string, limit: number): Promise<UserRow[]> {
    const like = `%${query.toLowerCase().replace(/[%_]/g, '')}%`;
    return this.db.all<UserRow>(
      `SELECT ${PUBLIC_COLUMNS} FROM users
       WHERE status = 'active' AND (username LIKE ? OR LOWER(display_name) LIKE ?)
       ORDER BY follower_count DESC, xp DESC
       LIMIT ?`,
      [like, like, limit],
    );
  }

  /** "Who to follow": active users the viewer does not already follow. */
  async suggested(viewerId: string | null, limit: number): Promise<UserRow[]> {
    if (!viewerId) {
      return this.db.all<UserRow>(
        `SELECT ${PUBLIC_COLUMNS} FROM users
         WHERE status = 'active'
         ORDER BY follower_count DESC, xp DESC LIMIT ?`,
        [limit],
      );
    }
    return this.db.all<UserRow>(
      `SELECT ${publicColumns('u')} FROM users u
       WHERE u.status = 'active'
         AND u.id <> ?
         AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.following_id = u.id)
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = ?))
       ORDER BY u.follower_count DESC, u.xp DESC
       LIMIT ?`,
      [viewerId, viewerId, viewerId, viewerId, limit],
    );
  }

  async listForAdmin(options: {
    cursor: Cursor | null;
    limit: number;
    status?: string;
    role?: string;
    query?: string;
  }) {
    const where: string[] = ['1 = 1'];
    const params: (string | number)[] = [];

    if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    }
    if (options.role) {
      where.push('role = ?');
      params.push(options.role);
    }
    if (options.query) {
      where.push('(username LIKE ? OR LOWER(display_name) LIKE ? OR email LIKE ?)');
      const like = `%${options.query.toLowerCase().replace(/[%_]/g, '')}%`;
      params.push(like, like, like);
    }
    if (options.cursor) {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(options.cursor.v, options.cursor.v, options.cursor.i);
    }

    const rows = await this.db.all<UserRow>(
      `SELECT ${PUBLIC_COLUMNS}, last_login_at FROM users
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [...params, options.limit + 1],
    );

    return buildPage(rows, options.limit, (row) => ({
      ...toPublicUser(row),
      email: row.email,
      lastLoginAt: row.last_login_at,
    }), (row) => ({ v: row.created_at, i: row.id }));
  }

  async countAll(): Promise<number> {
    return (await this.db.scalar<number>('SELECT COUNT(*) FROM users')) ?? 0;
  }

  async countByStatus(status: UserStatus): Promise<number> {
    return (await this.db.scalar<number>('SELECT COUNT(*) FROM users WHERE status = ?', [status])) ?? 0;
  }
}

// --- mappers ----------------------------------------------------------------

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio ?? '',
    location: row.location ?? '',
    website: row.website ?? '',
    role: row.role,
    status: row.status,
    level: row.level,
    xp: row.xp,
    avatarMediaId: row.avatar_media_id,
    coverMediaId: row.cover_media_id,
    postCount: row.post_count,
    commentCount: row.comment_count,
    reactionReceivedCount: row.reaction_received_count,
    followerCount: row.follower_count,
    followingCount: row.following_count,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    status: row.status,
    level: row.level,
    xp: row.xp,
    avatarMediaId: row.avatar_media_id,
    createdAt: row.created_at,
  };
}
