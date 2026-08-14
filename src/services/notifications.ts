/**
 * Notification service.
 *
 * Responsibilities:
 *  - create notifications for social events (never for your own actions);
 *  - remove them when the causing action is undone;
 *  - fan out to many recipients through the durable job queue rather than
 *    blocking the request;
 *  - map rows to DTOs with a rendered, already-escaped message.
 *
 * Fan-out note: Cloudflare Queues is a paid add-on and is left commented out in
 * `wrangler.toml`, so this project ships a durable `jobs` table drained by the
 * cron trigger and by `defer()` on the hot path. The `QueueLike` seam below
 * means switching to real Queues is a binding change, not a rewrite.
 */

import type { ServiceContext } from './context';
import type { NotificationDTO, NotificationType } from '../types/models';
import type { NotificationWithActor, CreateNotification } from '../db/repositories/notifications';
import { buildPage, type Cursor } from '../utils/cursor';
import { escapeHtml } from '../utils/html';

export interface NotifyInput extends CreateNotification {}

export class NotificationService {
  constructor(private readonly ctx: ServiceContext) {}

  /** Single recipient. Runs inline; callers usually wrap it in `defer()`. */
  async notify(input: NotifyInput): Promise<boolean> {
    try {
      return await this.ctx.repos.notifications.create(input);
    } catch (error) {
      // A notification must never break the action that triggered it.
      this.ctx.logger.warn('notification_failed', {
        type: input.type,
        error: error instanceof Error ? error.message : 'unknown',
      });
      return false;
    }
  }

  /**
   * Many recipients (mentions, and later "new post from someone you follow").
   * Small batches go inline; larger ones become a job so the request stays
   * within the Workers CPU budget.
   */
  async notifyMany(items: NotifyInput[]): Promise<void> {
    if (!items.length) return;
    if (items.length <= 20) {
      await this.ctx.repos.notifications.createMany(items);
      return;
    }
    await this.ctx.repos.jobs.enqueue('notification_fanout', { items });
  }

  async undo(input: {
    userId: string;
    actorId: string;
    type: NotificationType;
    targetType: string;
    targetId: string;
  }): Promise<void> {
    await this.ctx.repos.notifications.removeFor(input);
  }

  async list(options: {
    userId: string;
    cursor: Cursor | null;
    limit: number;
    unreadOnly?: boolean;
  }) {
    const rows = await this.ctx.repos.notifications.list(options);
    return buildPage(
      rows,
      options.limit,
      (row) => toNotificationDTO(row),
      (row) => ({ v: row.created_at, i: row.id }),
    );
  }

  async unreadCount(userId: string): Promise<number> {
    return this.ctx.repos.notifications.unreadCount(userId);
  }

  async markRead(userId: string, ids: string[]): Promise<number> {
    return this.ctx.repos.notifications.markRead(userId, ids);
  }

  async markAllRead(userId: string): Promise<number> {
    return this.ctx.repos.notifications.markAllRead(userId);
  }

  async remove(userId: string, id: string): Promise<boolean> {
    return this.ctx.repos.notifications.remove(userId, id);
  }
}

/** Row → DTO. `data_json` is parsed defensively: it is written by us, but a
 *  malformed value must not throw inside a list render. */
export function toNotificationDTO(row: NotificationWithActor): NotificationDTO {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.data_json || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }

  return {
    id: row.id,
    type: row.type,
    targetType: row.target_type,
    targetId: row.target_id,
    data,
    readAt: row.read_at,
    createdAt: row.created_at,
    actor: row.actor_username
      ? {
          id: row.actor_id ?? '',
          username: row.actor_username,
          displayName: row.actor_display_name ?? row.actor_username,
          avatarMediaId: row.actor_avatar_media_id ?? null,
        }
      : null,
  };
}

/**
 * Human-readable summary for a notification, used by SSR and the client list.
 * Returns plain text; callers escape it (or use `notificationHtml`).
 */
export function notificationText(dto: NotificationDTO): string {
  const who = dto.actor?.displayName ?? 'Someone';
  const title = typeof dto.data['title'] === 'string' ? (dto.data['title'] as string) : '';
  // Direct messages ride on the SYSTEM type (the `notifications.type` CHECK
  // predates messaging), so they are recognised by their target instead.
  if (dto.targetType === 'conversation') {
    const preview = typeof dto.data['preview'] === 'string' ? (dto.data['preview'] as string) : '';
    return preview ? `${who}: ${preview}` : `${who} sent you a message`;
  }
  switch (dto.type) {
    case 'FOLLOW':
      return `${who} started following you`;
    case 'LIKE':
      return `${who} reacted to your ${dto.targetType === 'comment' ? 'comment' : 'post'}`;
    case 'COMMENT':
      return `${who} commented on your post`;
    case 'REPLY':
      return `${who} replied to your comment`;
    case 'MENTION':
      return `${who} mentioned you`;
    case 'MODERATION':
      return title || 'A moderator took action on your content';
    case 'SYSTEM':
    default:
      return title || 'You have a new notification';
  }
}

/** Escaped one-line HTML with the actor's name emphasised. */
export function notificationHtml(dto: NotificationDTO): string {
  const text = notificationText(dto);
  const who = dto.actor?.displayName;
  if (who && text.startsWith(who)) {
    return `<strong>${escapeHtml(who)}</strong>${escapeHtml(text.slice(who.length))}`;
  }
  return escapeHtml(text);
}

/** Where clicking the notification should take the reader. */
export function notificationHref(dto: NotificationDTO): string {
  if (dto.targetType === 'conversation' && dto.targetId) {
    return `/messages/${encodeURIComponent(dto.targetId)}`;
  }
  const slug = typeof dto.data['postSlug'] === 'string' ? (dto.data['postSlug'] as string) : '';
  const commentId =
    typeof dto.data['commentId'] === 'string' ? (dto.data['commentId'] as string) : '';

  switch (dto.type) {
    case 'FOLLOW':
      return dto.actor ? `/u/${encodeURIComponent(dto.actor.username)}` : '/notifications';
    case 'COMMENT':
    case 'REPLY':
    case 'MENTION':
      if (slug) return `/post/${encodeURIComponent(slug)}${commentId ? `#${commentId}` : ''}`;
      return '/notifications';
    case 'LIKE':
      return slug ? `/post/${encodeURIComponent(slug)}` : '/notifications';
    case 'MODERATION':
      return slug ? `/post/${encodeURIComponent(slug)}` : '/notifications';
    default:
      return '/notifications';
  }
}
