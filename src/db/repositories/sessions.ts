/**
 * Session repository.
 *
 * Only the SHA-256 hash of a session token is ever stored, so a database dump
 * cannot be replayed as a login. The plaintext token exists solely in the
 * user's HttpOnly cookie.
 */

import { Db } from '../client';
import type { SessionRow, UserRow } from '../../types/models';
import { newId, randomToken } from '../../utils/id';
import { sha256Hex } from '../../utils/crypto';
import { now } from '../../utils/time';
import { SESSION_ABSOLUTE_TTL, SESSION_IDLE_TTL, SESSION_TOUCH_INTERVAL } from '../../config';

export interface IssuedSession {
  /** Plaintext token — goes into the cookie and is never persisted. */
  token: string;
  sessionId: string;
  expiresAt: number;
  absoluteExpiry: number;
}

export interface SessionWithUser {
  session: SessionRow;
  user: UserRow;
}

export class SessionRepository {
  constructor(private readonly db: Db) {}

  /**
   * Create a fresh session. Callers rotate on login by revoking the old
   * session id first, which defeats session fixation.
   */
  async issue(input: {
    userId: string;
    ipHash: string;
    userAgentHash: string;
  }): Promise<IssuedSession> {
    const token = randomToken(32);
    const tokenHash = await sha256Hex(token);
    const id = newId('ses');
    const ts = now();
    const expiresAt = ts + SESSION_IDLE_TTL;
    const absoluteExpiry = ts + SESSION_ABSOLUTE_TTL;

    await this.db.run(
      `INSERT INTO sessions
         (id, user_id, token_hash, expires_at, absolute_expiry, created_at, last_seen_at, ip_hash, user_agent_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.userId, tokenHash, expiresAt, absoluteExpiry, ts, ts, input.ipHash, input.userAgentHash],
    );

    return { token, sessionId: id, expiresAt, absoluteExpiry };
  }

  /**
   * Resolve a cookie token to its session and user in a single query.
   * Expired, revoked and non-active accounts are filtered in SQL so a stale
   * cookie can never authenticate.
   */
  async resolve(token: string): Promise<SessionWithUser | null> {
    if (!token || token.length > 128) return null;
    const tokenHash = await sha256Hex(token);
    const ts = now();

    const row = await this.db.first<Record<string, unknown>>(
      `SELECT
         s.id AS s_id, s.user_id AS s_user_id, s.token_hash AS s_token_hash,
         s.expires_at AS s_expires_at, s.absolute_expiry AS s_absolute_expiry,
         s.created_at AS s_created_at, s.last_seen_at AS s_last_seen_at,
         s.ip_hash AS s_ip_hash, s.user_agent_hash AS s_user_agent_hash,
         s.revoked_at AS s_revoked_at,
         u.*
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?
         AND s.revoked_at IS NULL
         AND s.expires_at > ?
         AND s.absolute_expiry > ?
       LIMIT 1`,
      [tokenHash, ts, ts],
    );
    if (!row) return null;

    const session: SessionRow = {
      id: row['s_id'] as string,
      user_id: row['s_user_id'] as string,
      token_hash: row['s_token_hash'] as string,
      expires_at: row['s_expires_at'] as number,
      absolute_expiry: row['s_absolute_expiry'] as number,
      created_at: row['s_created_at'] as number,
      last_seen_at: row['s_last_seen_at'] as number,
      ip_hash: row['s_ip_hash'] as string,
      user_agent_hash: row['s_user_agent_hash'] as string,
      revoked_at: (row['s_revoked_at'] as number | null) ?? null,
    };

    const user = row as unknown as UserRow;
    return { session, user };
  }

  /**
   * Sliding expiration: extend an active session, but never past its absolute
   * expiry. Only touched every `SESSION_TOUCH_INTERVAL` to avoid a write per
   * request.
   */
  async touch(session: SessionRow): Promise<number> {
    const ts = now();
    if (ts - session.last_seen_at < SESSION_TOUCH_INTERVAL) {
      return session.expires_at;
    }
    const expiresAt = Math.min(ts + SESSION_IDLE_TTL, session.absolute_expiry);
    await this.db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', [
      ts,
      expiresAt,
      session.id,
    ]);
    return expiresAt;
  }

  /** Explicit refresh (POST /api/auth/refresh) — always writes. */
  async refresh(sessionId: string): Promise<number | null> {
    const session = await this.db.first<SessionRow>('SELECT * FROM sessions WHERE id = ?', [
      sessionId,
    ]);
    if (!session || session.revoked_at !== null) return null;
    const ts = now();
    if (session.absolute_expiry <= ts) return null;
    const expiresAt = Math.min(ts + SESSION_IDLE_TTL, session.absolute_expiry);
    await this.db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', [
      ts,
      expiresAt,
      sessionId,
    ]);
    return expiresAt;
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [
      now(),
      sessionId,
    ]);
  }

  /** Used on password change and account deletion. */
  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<number> {
    const ts = now();
    const result = exceptSessionId
      ? await this.db.run(
          'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL',
          [ts, userId, exceptSessionId],
        )
      : await this.db.run(
          'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
          [ts, userId],
        );
    return result.changes;
  }

  async listForUser(userId: string): Promise<SessionRow[]> {
    return this.db.all<SessionRow>(
      `SELECT * FROM sessions
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY last_seen_at DESC LIMIT 50`,
      [userId, now()],
    );
  }

  /** Cron: delete revoked/expired rows. Returns how many were removed. */
  async purgeExpired(limit = 1000): Promise<number> {
    const ts = now();
    const result = await this.db.run(
      `DELETE FROM sessions
       WHERE id IN (
         SELECT id FROM sessions
         WHERE expires_at < ? OR absolute_expiry < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)
         LIMIT ?
       )`,
      [ts, ts, ts - 86400, limit],
    );
    return result.changes;
  }

  async countActive(): Promise<number> {
    return (
      (await this.db.scalar<number>(
        'SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL AND expires_at > ?',
        [now()],
      )) ?? 0
    );
  }

  // --- One-time auth tokens (password reset / email verification) -----------

  async createAuthToken(input: {
    userId: string;
    kind: 'password_reset' | 'email_verify';
    ttlSeconds: number;
  }): Promise<string> {
    const token = randomToken(32);
    const ts = now();
    await this.db.batch([
      {
        // A new token invalidates any outstanding one for the same purpose.
        sql: `UPDATE auth_tokens SET used_at = ?
              WHERE user_id = ? AND kind = ? AND used_at IS NULL`,
        params: [ts, input.userId, input.kind],
      },
      {
        sql: `INSERT INTO auth_tokens (id, user_id, token_hash, kind, expires_at, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        params: [
          newId('tok'),
          input.userId,
          await sha256Hex(token),
          input.kind,
          ts + input.ttlSeconds,
          ts,
        ],
      },
    ]);
    return token;
  }

  /** Consume a one-time token atomically; a replay returns null. */
  async consumeAuthToken(
    token: string,
    kind: 'password_reset' | 'email_verify',
  ): Promise<string | null> {
    const tokenHash = await sha256Hex(token);
    const ts = now();
    const row = await this.db.first<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM auth_tokens
       WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?`,
      [tokenHash, kind, ts],
    );
    if (!row) return null;

    const result = await this.db.run(
      'UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL',
      [ts, row.id],
    );
    if (!result.changes) return null;
    return row.user_id;
  }

  async purgeExpiredAuthTokens(): Promise<number> {
    const result = await this.db.run('DELETE FROM auth_tokens WHERE expires_at < ?', [
      now() - 86400,
    ]);
    return result.changes;
  }
}
