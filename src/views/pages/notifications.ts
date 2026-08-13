/**
 * `/notifications` — server-rendered inbox.
 *
 * Never cached (the render helper sets `private, no-store` for signed-in
 * responses). The list has a cursor "load more" that the client upgrades.
 */

import { html, raw } from '../../utils/html';
import type { NotificationDTO, Page } from '../../types/models';
import { relativeTime, toIso } from '../../utils/time';
import { avatar } from '../components/avatar';
import { emptyState } from '../components/post';
import { notificationHref, notificationHtml } from '../../services/notifications';

export interface NotificationsPageInput {
  page: Page<NotificationDTO>;
  unreadCount: number;
  unreadOnly: boolean;
  csrfToken: string | null;
}

const ICONS: Record<string, string> = {
  FOLLOW: '👤',
  LIKE: '❤️',
  COMMENT: '💬',
  REPLY: '↩️',
  MENTION: '@',
  SYSTEM: '🔔',
  MODERATION: '🛡️',
};

function notificationItem(item: NotificationDTO): string {
  const href = notificationHref(item);
  const icon = ICONS[item.type] ?? '🔔';

  return html`
    <li class="notif ${item.readAt ? '' : 'notif--unread'}" data-notification-id="${item.id}">
      <span class="notif__icon" aria-hidden="true">${icon}</span>
      <div class="notif__body">
        <div class="notif__actor">
          ${item.actor
            ? avatar(
                {
                  id: item.actor.id,
                  username: item.actor.username,
                  displayName: item.actor.displayName,
                  avatarMediaId: item.actor.avatarMediaId,
                },
                'sm',
              )
            : ''}
          <a class="notif__text" href="${href}">${raw(notificationHtml(item))}</a>
        </div>
        <time class="notif__time muted" datetime="${toIso(item.createdAt)}">${relativeTime(item.createdAt)}</time>
      </div>
      ${item.readAt ? '' : raw(html`<span class="notif__dot" aria-label="Unread"></span>`)}
    </li>
  `;
}

export function renderNotificationsPage(input: NotificationsPageInput): string {
  const { page } = input;

  return html`
    <div class="pagehead">
      <h1 class="pagehead__title">Notifications</h1>
      <p class="pagehead__sub muted">
        ${input.unreadCount > 0 ? `${input.unreadCount} unread` : 'You are all caught up'}
      </p>
    </div>

    <div class="toolbar">
      <nav class="tabs" aria-label="Notification filter">
        <a class="tab ${input.unreadOnly ? '' : 'is-active'}" href="/notifications"
           ${input.unreadOnly ? '' : raw('aria-current="page"')}>All</a>
        <a class="tab ${input.unreadOnly ? 'is-active' : ''}" href="/notifications?unread=1"
           ${input.unreadOnly ? raw('aria-current="page"') : ''}>Unread</a>
      </nav>

      ${input.csrfToken
        ? raw(html`
            <form method="post" action="/api/notifications/read-all" data-settings-form data-reload="1">
              <input type="hidden" name="_csrf" value="${input.csrfToken}">
              <button class="btn btn--small btn--ghost" type="submit" ${input.unreadCount ? '' : raw('disabled')}>
                Mark all read
              </button>
            </form>`)
        : ''}
    </div>

    ${page.items.length
      ? raw(html`
          <ul class="notiflist" data-feed data-endpoint="/api/notifications${input.unreadOnly ? '?unreadOnly=true' : ''}">
            ${page.items.map((item) => raw(notificationItem(item)))}
          </ul>
          ${page.hasMore && page.nextCursor
            ? raw(html`
                <div class="loadmore">
                  <button class="btn btn--ghost btn--block" type="button" data-load-more
                          data-cursor="${page.nextCursor}">Load more</button>
                </div>`)
            : ''}`)
      : raw(
          emptyState(
            'Nothing here yet',
            'Follows, reactions, replies and mentions will show up on this page.',
            { href: '/explore', label: 'Find people to follow' },
          ),
        )}
  `;
}
