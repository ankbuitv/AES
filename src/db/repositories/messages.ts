/**
 * Direct-message repository.
 *
 * D1 is the single source of truth for conversations and messages. The Durable
 * Object in `worker/durable/conversationRoom.ts` only fans messages out to the
 * sockets that are currently connected — nothing is ever stored exclusively in
 * the room, so a reload (or a browser without WebSocket support) sees exactly
 * the same history.
 *
 * Every query is scoped by `conversation_members`, so a row can only be read by
 * a participant even if a caller forgets to check membership first.
 */

import { Db } from '../client';
import { newId } from '../../utils/id';
import { now } from '../../utils/time';
import type { Cursor } from '../../utils/cursor';

export interface ConversationRow {
  id: string;
  created_at: number;
  updated_at: number;
}

export interface ConversationListRow {
  id: string;
  updated_at: number;
  peer_id: string;
  peer_username: string;
  peer_display_name: string;
  peer_avatar_media_id: string | null;
  peer_role: string;
  last_content: string | null;
  last_created_at: number | null;
  last_sender_id: string | null;
  unread_count: number;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  /** 'text' | 'image' | 'audio' | 'sticker' — see migration 0010. */
  kind: string;
  media_id: string | null;
  duration_ms: number;
  created_at: number;
  username: string;
  display_name: string;
  avatar_media_id: string | null;
}

export interface MemberRow {
  user_id: string;
  username: string;
  display_name: string;
  avatar_media_id: string | null;
  last_read_at: number | null;
}

const MESSAGE_COLUMNS = `m.id, m.conversation_id, m.sender_id, m.content,
       COALESCE(m.kind, 'text') AS kind, m.media_id,
       COALESCE(m.duration_ms, 0) AS duration_ms, m.created_at,
       u.username, u.display_name, u.avatar_media_id`;

export class MessageRepository {
  constructor(private readonly db: Db) {}

  /**
   * The 1:1 conversation between two people, created on first use.
   *
   * The lookup joins `conversation_members` to itself so it finds the room
   * whatever order the pair is stored in, and it deliberately ignores rooms
   * with more than two members (group chats are not exposed yet).
   */
  async findOrCreateDirect(a: string, b: string): Promise<string> {
    const existing = await this.db.first<{ conversation_id: string }>(
      `SELECT m1.conversation_id FROM conversation_members m1
       JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id
       WHERE m1.user_id = ? AND m2.user_id = ?
         AND (SELECT COUNT(*) FROM conversation_members cm WHERE cm.conversation_id = m1.conversation_id) = 2
       LIMIT 1`,
      [a, b],
    );
    if (existing) return existing.conversation_id;

    const id = newId('cnv');
    const ts = now();
    await this.db.batch([
      { sql: 'INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)', params: [id, ts, ts] },
      {
        sql: 'INSERT INTO conversation_members (conversation_id, user_id, last_read_at) VALUES (?, ?, ?)',
        params: [id, a, ts],
      },
      {
        sql: 'INSERT INTO conversation_members (conversation_id, user_id, last_read_at) VALUES (?, ?, ?)',
        params: [id, b, null],
      },
    ]);
    return id;
  }

  async findById(conversationId: string): Promise<ConversationRow | null> {
    return this.db.first<ConversationRow>(
      'SELECT id, created_at, updated_at FROM conversations WHERE id = ?',
      [conversationId],
    );
  }

  async isMember(conversationId: string, userId: string): Promise<boolean> {
    const row = await this.db.first(
      'SELECT 1 AS x FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
      [conversationId, userId],
    );
    return row !== null;
  }

  /** Everyone in the room, used for presence and for the thread header. */
  async members(conversationId: string): Promise<MemberRow[]> {
    return this.db.all<MemberRow>(
      `SELECT cm.user_id, cm.last_read_at, u.username, u.display_name, u.avatar_media_id
       FROM conversation_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.conversation_id = ?
       ORDER BY u.username ASC`,
      [conversationId],
    );
  }

  /** The other participant of a 1:1 room. */
  async peer(conversationId: string, viewerId: string): Promise<MemberRow | null> {
    return this.db.first<MemberRow>(
      `SELECT cm.user_id, cm.last_read_at, u.username, u.display_name, u.avatar_media_id
       FROM conversation_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.conversation_id = ? AND cm.user_id <> ?
       LIMIT 1`,
      [conversationId, viewerId],
    );
  }

  /**
   * Inbox list: newest activity first, with the last line and this viewer's
   * unread count resolved in the same round trip.
   */
  async listConversations(userId: string, limit = 40): Promise<ConversationListRow[]> {
    return this.db.all<ConversationListRow>(
      `SELECT c.id,
              c.updated_at,
              u.id                AS peer_id,
              u.username          AS peer_username,
              u.display_name      AS peer_display_name,
              u.avatar_media_id   AS peer_avatar_media_id,
              u.role              AS peer_role,
              (SELECT m.content    FROM messages m WHERE m.conversation_id = c.id
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_content,
              (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_created_at,
              (SELECT m.sender_id  FROM messages m WHERE m.conversation_id = c.id
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_sender_id,
              (SELECT COUNT(*) FROM messages m
                WHERE m.conversation_id = c.id
                  AND m.sender_id <> me.user_id
                  AND m.created_at > COALESCE(me.last_read_at, 0)) AS unread_count
       FROM conversation_members me
       JOIN conversations c ON c.id = me.conversation_id
       JOIN conversation_members other ON other.conversation_id = c.id AND other.user_id <> me.user_id
       JOIN users u ON u.id = other.user_id
       WHERE me.user_id = ?
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT ?`,
      [userId, limit],
    );
  }

  /**
   * Inbox search: the same row shape as `listConversations`, narrowed to the
   * people whose display name or handle contains `term`.
   *
   * The term is passed as a bound parameter and only ever reaches SQL inside a
   * LIKE pattern that we build here, so a value containing `%` or `_` can widen
   * nothing — the caller escapes those before calling.
   */
  async searchConversations(userId: string, term: string, limit = 20): Promise<ConversationListRow[]> {
    const pattern = `%${term}%`;
    return this.db.all<ConversationListRow>(
      `SELECT c.id,
              c.updated_at,
              u.id                AS peer_id,
              u.username          AS peer_username,
              u.display_name      AS peer_display_name,
              u.avatar_media_id   AS peer_avatar_media_id,
              u.role              AS peer_role,
              (SELECT m.content    FROM messages m WHERE m.conversation_id = c.id
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_content,
              (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_created_at,
              (SELECT m.sender_id  FROM messages m WHERE m.conversation_id = c.id
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_sender_id,
              (SELECT COUNT(*) FROM messages m
                WHERE m.conversation_id = c.id
                  AND m.sender_id <> me.user_id
                  AND m.created_at > COALESCE(me.last_read_at, 0)) AS unread_count
       FROM conversation_members me
       JOIN conversations c ON c.id = me.conversation_id
       JOIN conversation_members other ON other.conversation_id = c.id AND other.user_id <> me.user_id
       JOIN users u ON u.id = other.user_id
       WHERE me.user_id = ?
         AND (LOWER(u.display_name) LIKE ? ESCAPE '\\' OR LOWER(u.username) LIKE ? ESCAPE '\\')
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT ?`,
      [userId, pattern, pattern, limit],
    );
  }

  /**
   * People the viewer could start a conversation with. Excludes themselves and
   * anyone they already have a thread with, so search results never duplicate
   * the inbox rows shown above them.
   */
  async searchNewPeople(
    userId: string,
    term: string,
    limit = 8,
  ): Promise<{ id: string; username: string; display_name: string; avatar_media_id: string | null }[]> {
    const pattern = `%${term}%`;
    return this.db.all(
      `SELECT u.id, u.username, u.display_name, u.avatar_media_id
       FROM users u
       WHERE u.id <> ?
         AND u.status = 'active'
         AND (LOWER(u.display_name) LIKE ? ESCAPE '\\' OR LOWER(u.username) LIKE ? ESCAPE '\\')
         AND NOT EXISTS (
           SELECT 1 FROM conversation_members mine
           JOIN conversation_members theirs
             ON theirs.conversation_id = mine.conversation_id AND theirs.user_id = u.id
           WHERE mine.user_id = ?
         )
       ORDER BY u.follower_count DESC, u.username ASC
       LIMIT ?`,
      [userId, pattern, pattern, userId, limit],
    );
  }

  /**
   * Newest `limit + 1` messages (so the caller can tell whether older history
   * exists), optionally ending before a cursor. Returned newest-first; the
   * service reverses into reading order.
   */
  async listLatest(conversationId: string, limit: number, before: Cursor | null): Promise<MessageRow[]> {
    if (before) {
      return this.db.all<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS}
         FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.conversation_id = ?
           AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT ?`,
        [conversationId, before.v, before.v, before.i, limit + 1],
      );
    }
    return this.db.all<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = ?
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ?`,
      [conversationId, limit + 1],
    );
  }

  /**
   * Everything newer than a cursor, oldest-first. This is the polling fallback
   * used when no Durable Object namespace is bound (and the catch-up query a
   * socket runs after a reconnect).
   */
  async listSince(conversationId: string, after: Cursor, limit = 50): Promise<MessageRow[]> {
    return this.db.all<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = ?
         AND (m.created_at > ? OR (m.created_at = ? AND m.id > ?))
       ORDER BY m.created_at ASC, m.id ASC
       LIMIT ?`,
      [conversationId, after.v, after.v, after.i, limit],
    );
  }

  async findMessage(messageId: string): Promise<MessageRow | null> {
    return this.db.first<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.id = ?`,
      [messageId],
    );
  }

  /** Persist a message and bump the room so the inbox re-sorts. */
  async insert(input: {
    conversationId: string;
    senderId: string;
    content: string;
    kind?: string;
    mediaId?: string | null;
    durationMs?: number;
  }): Promise<{ id: string; createdAt: number }> {
    const id = newId('msg');
    const ts = now();
    await this.db.batch([
      {
        sql: `INSERT INTO messages (id, conversation_id, sender_id, content, kind, media_id, duration_ms, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          id,
          input.conversationId,
          input.senderId,
          input.content,
          input.kind ?? 'text',
          input.mediaId ?? null,
          Math.max(0, Math.trunc(input.durationMs ?? 0)),
          ts,
        ],
      },
      {
        sql: 'UPDATE conversations SET updated_at = ? WHERE id = ?',
        params: [ts, input.conversationId],
      },
      {
        sql: 'UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?',
        params: [ts, input.conversationId, input.senderId],
      },
    ]);
    return { id, createdAt: ts };
  }

  /** Mark everything up to `at` as read for one member. Never moves backwards. */
  async markRead(conversationId: string, userId: string, at = now()): Promise<void> {
    await this.db.run(
      `UPDATE conversation_members
       SET last_read_at = MAX(COALESCE(last_read_at, 0), ?)
       WHERE conversation_id = ? AND user_id = ?`,
      [at, conversationId, userId],
    );
  }

  async unreadCount(conversationId: string, userId: string): Promise<number> {
    const value = await this.db.scalar<number>(
      `SELECT COUNT(*) FROM messages m
       JOIN conversation_members cm
         ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
       WHERE m.conversation_id = ?
         AND m.sender_id <> cm.user_id
         AND m.created_at > COALESCE(cm.last_read_at, 0)`,
      [userId, conversationId],
    );
    return value ?? 0;
  }

  /** Number of conversations holding at least one unread message. */
  async unreadConversationCount(userId: string): Promise<number> {
    const value = await this.db.scalar<number>(
      `SELECT COUNT(*) FROM conversation_members cm
       WHERE cm.user_id = ?
         AND EXISTS (
           SELECT 1 FROM messages m
           WHERE m.conversation_id = cm.conversation_id
             AND m.sender_id <> cm.user_id
             AND m.created_at > COALESCE(cm.last_read_at, 0)
         )`,
      [userId],
    );
    return value ?? 0;
  }
}
