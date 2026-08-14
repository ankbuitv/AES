/**
 * Direct-message service.
 *
 * Owns the rules of a conversation: who may open one, what a message may
 * contain, and how history is paginated. Delivery is layered on top and is
 * deliberately optional — `deliver()` best-effort notifies the conversation's
 * Durable Object so connected sockets receive the message immediately, but the
 * write to D1 has already succeeded by then. If the DO namespace is not bound,
 * or the fan-out fails, clients still converge through the `?after=` polling
 * endpoint. The chat therefore degrades, it never loses a message.
 */

import type { ServiceContext } from './context';
import type { ConversationDTO, MessageDTO, MessageKind } from '../types/models';
import type {
  ConversationListRow,
  MessageRow,
} from '../db/repositories/messages';
import type { UserRole } from '../types/models';
import { AppError } from '../utils/errors';
import { LIMITS } from '../config';
import { assertNoControlChars } from '../validators/common';
import { encodeCursor, type Cursor } from '../utils/cursor';
import type { MessagePeer } from '../types/models';

/** Readable stand-in when an attachment is sent without a caption. */
const ATTACHMENT_FALLBACK: Record<MessageKind, string> = {
  text: '',
  image: 'Photo',
  audio: 'Voice message',
  sticker: 'Sticker',
};

/**
 * Prepare a user-typed search term for a LIKE pattern.
 *
 * `%` and `_` are LIKE wildcards: left alone, typing `%` would match every
 * conversation. They are escaped here (the queries declare ESCAPE '\\') so the
 * term can only ever match itself.
 */
function normalizeSearchTerm(value: string): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .slice(0, 60)
    .replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface ThreadPage {
  items: MessageDTO[];
  /** Cursor for *older* history, `null` when the start of the thread is loaded. */
  nextCursor: string | null;
  hasMore: boolean;
  /** Cursor of the newest message; hand it back as `?after=` to poll. */
  latestCursor: string | null;
}

export class MessageService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * Trim, validate and clamp an outgoing message body.
   *
   * Emoji need no special handling: they are ordinary (multi-byte) characters,
   * and the control-character check below deliberately targets the C0/C1 ranges
   * only, so every pictograph, skin-tone modifier and ZWJ sequence survives
   * intact.
   */
  static sanitize(raw: string): string {
    // Keep newlines (they are meaningful in chat), drop other control chars.
    const text = raw.replace(/\r\n/g, '\n').replace(/[^\S\n]+$/gm, '').trim();
    if (!text) throw AppError.badRequest('Message cannot be empty');
    assertNoControlChars(text.replace(/\n/g, ' '), 'Message');
    if (text.length > LIMITS.messageContentMax) {
      throw AppError.badRequest(`Message must be at most ${LIMITS.messageContentMax} characters`);
    }
    return text;
  }

  /**
   * Caption for an attachment bubble. Unlike `sanitize` an empty result is
   * fine — the attachment *is* the message — so this never throws.
   */
  static sanitizeCaption(raw: string, fallback: string): string {
    const text = (raw ?? '').replace(/\r\n/g, '\n').replace(/[^\S\n]+$/gm, '').trim();
    if (!text) return fallback;
    assertNoControlChars(text.replace(/\n/g, ' '), 'Message');
    return text.slice(0, LIMITS.messageContentMax);
  }

  /** Open (or reuse) the 1:1 conversation with `username`. */
  async openWith(viewerId: string, username: string): Promise<{ conversationId: string; peerId: string }> {
    const peer = await this.ctx.repos.users.findByUsername(username);
    if (!peer) throw AppError.notFound('That member does not exist');
    if (peer.id === viewerId) throw AppError.badRequest('You cannot message yourself');
    if (peer.status === 'banned' || peer.status === 'suspended') {
      throw AppError.forbidden('That member cannot receive messages');
    }
    const conversationId = await this.ctx.repos.messages.findOrCreateDirect(viewerId, peer.id);
    return { conversationId, peerId: peer.id };
  }

  /** Throws unless `viewerId` is a participant. Every read path calls this. */
  async assertMember(conversationId: string, viewerId: string): Promise<void> {
    const member = await this.ctx.repos.messages.isMember(conversationId, viewerId);
    // 404 rather than 403: a non-member must not learn that the room exists.
    if (!member) throw AppError.notFound('Conversation not found');
  }

  async listConversations(viewerId: string, limit = 40): Promise<ConversationDTO[]> {
    const rows = await this.ctx.repos.messages.listConversations(viewerId, limit);
    return rows.map((row) => toConversationDTO(row, viewerId));
  }

  /**
   * Incremental inbox search: as soon as the user types one character we return
   * the conversations whose peer matches, plus a few people they have not
   * messaged yet so "search then start a chat" is one flow rather than two.
   */
  async searchInbox(
    viewerId: string,
    rawTerm: string,
  ): Promise<{ conversations: ConversationDTO[]; people: MessagePeer[] }> {
    const term = normalizeSearchTerm(rawTerm);
    if (!term) {
      return { conversations: await this.listConversations(viewerId), people: [] };
    }

    const [rows, people] = await Promise.all([
      this.ctx.repos.messages.searchConversations(viewerId, term, 25),
      this.ctx.repos.messages.searchNewPeople(viewerId, term, 8),
    ]);

    return {
      conversations: rows.map((row) => toConversationDTO(row, viewerId)),
      people: people.map((person) => ({
        id: person.id,
        username: person.username,
        displayName: person.display_name || person.username,
        avatarMediaId: person.avatar_media_id,
      })),
    };
  }

  async peerOf(conversationId: string, viewerId: string) {
    return this.ctx.repos.messages.peer(conversationId, viewerId);
  }

  /**
   * A page of history, oldest-first for rendering. `before` walks backwards
   * into the archive; the returned `latestCursor` is what a poller resumes at.
   */
  async thread(options: {
    conversationId: string;
    viewerId: string;
    limit: number;
    before?: Cursor | null;
  }): Promise<ThreadPage> {
    const limit = Math.max(1, Math.min(options.limit, 50));
    const rows = await this.ctx.repos.messages.listLatest(
      options.conversationId,
      limit,
      options.before ?? null,
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const oldest = page[page.length - 1];
    const newest = page[0];
    const items = [...page].reverse().map((row) => toMessageDTO(row, options.viewerId));

    return {
      items,
      nextCursor: hasMore && oldest ? encodeCursor({ v: oldest.created_at, i: oldest.id }) : null,
      hasMore,
      latestCursor: newest ? encodeCursor({ v: newest.created_at, i: newest.id }) : null,
    };
  }

  /** Everything after `after`, oldest-first. Used by the polling fallback. */
  async since(options: {
    conversationId: string;
    viewerId: string;
    after: Cursor;
    limit?: number;
  }): Promise<{ items: MessageDTO[]; latestCursor: string | null }> {
    const rows = await this.ctx.repos.messages.listSince(
      options.conversationId,
      options.after,
      Math.max(1, Math.min(options.limit ?? 50, 50)),
    );
    const items = rows.map((row) => toMessageDTO(row, options.viewerId));
    const newest = rows[rows.length - 1];
    return {
      items,
      latestCursor: newest ? encodeCursor({ v: newest.created_at, i: newest.id }) : null,
    };
  }

  /**
   * Persist a message, then fan it out. The caller must already have checked
   * membership; `send` re-checks anyway because it is the one write path.
   */
  async send(options: {
    conversationId: string;
    senderId: string;
    content: string;
    kind?: MessageKind;
    mediaId?: string | null;
    durationMs?: number;
    /** Echoed on the socket so the sender can reconcile its optimistic bubble. */
    clientId?: string;
  }): Promise<MessageDTO> {
    const kind: MessageKind = options.kind ?? 'text';
    // Text bubbles must carry text; attachment bubbles fall back to a short
    // label so previews and screen readers always have something to read.
    const content =
      kind === 'text'
        ? MessageService.sanitize(options.content)
        : MessageService.sanitizeCaption(options.content, ATTACHMENT_FALLBACK[kind]);
    await this.assertMember(options.conversationId, options.senderId);

    const { id } = await this.ctx.repos.messages.insert({
      conversationId: options.conversationId,
      senderId: options.senderId,
      content,
      kind,
      mediaId: options.mediaId ?? null,
      durationMs: options.durationMs ?? 0,
    });

    const row = await this.ctx.repos.messages.findMessage(id);
    if (!row) throw new AppError('INTERNAL_ERROR', 'Message could not be stored');
    const dto = toMessageDTO(row, options.senderId);

    // Fan-out happens after the response is on its way: a socket that misses
    // the push still catches up on its next poll or reconnect.
    this.ctx.defer(this.deliver(options.conversationId, row, options.clientId));

    return dto;
  }

  /**
   * Best-effort push to the conversation's Durable Object. Never throws: this
   * is an optimisation over the durable D1 write, not a second source of truth.
   */
  async deliver(conversationId: string, row: MessageRow, clientId?: string): Promise<void> {
    const namespace = this.ctx.env.CONVERSATIONS;
    if (!namespace) return;
    try {
      const stub = namespace.get(namespace.idFromName(conversationId));
      // `mine` is left false here: each client re-derives it from sender.id.
      // `clientId` lets the author replace the optimistic bubble when this
      // push races the HTTP response (otherwise they see their own line twice).
      await stub.fetch('https://conversation.internal/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'message',
          message: { ...toMessageDTO(row, ''), clientId: clientId || undefined },
        }),
      });
    } catch (error) {
      this.ctx.logger.warn('message_fanout_failed', {
        conversationId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  async markRead(conversationId: string, viewerId: string): Promise<void> {
    await this.ctx.repos.messages.markRead(conversationId, viewerId);
  }

  async unreadConversationCount(viewerId: string): Promise<number> {
    try {
      return await this.ctx.repos.messages.unreadConversationCount(viewerId);
    } catch {
      return 0;
    }
  }
}

/**
 * Row → DTO. `viewerId` decides `mine`; pass an empty string when the DTO is
 * being broadcast to several viewers (each client re-derives it from the
 * sender id it already knows).
 */
export function toMessageDTO(row: MessageRow, viewerId: string): MessageDTO {
  const kind = (row.kind || 'text') as MessageKind;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    content: row.content,
    kind,
    // Attachments are streamed through the Worker gateway like every other
    // object; the bucket hostname never reaches the browser.
    mediaUrl: row.media_id ? `/media/${encodeURIComponent(row.media_id)}` : null,
    durationMs: Number(row.duration_ms ?? 0),
    createdAt: row.created_at,
    mine: row.sender_id === viewerId,
    sender: {
      id: row.sender_id,
      username: row.username,
      displayName: row.display_name || row.username,
      avatarMediaId: row.avatar_media_id,
    },
  };
}

export function toConversationDTO(row: ConversationListRow, viewerId: string): ConversationDTO {
  return {
    id: row.id,
    updatedAt: row.updated_at,
    peer: {
      id: row.peer_id,
      username: row.peer_username,
      displayName: row.peer_display_name || row.peer_username,
      avatarMediaId: row.peer_avatar_media_id,
      role: (row.peer_role || 'member') as UserRole,
    },
    lastMessage:
      row.last_content !== null && row.last_created_at !== null
        ? {
            content: row.last_content,
            createdAt: row.last_created_at,
            mine: row.last_sender_id === viewerId,
          }
        : null,
    unreadCount: Number(row.unread_count ?? 0),
  };
}
