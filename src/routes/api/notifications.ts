/**
 * Notifications. Strictly private: every response is `no-store` and scoped to
 * the signed-in user by id inside the repository query itself.
 */

import { Hono } from 'hono';
import type { AppContext } from '../../types/env';
import { serviceContext } from '../../services/context';
import {
  NotificationService,
  notificationHref,
  notificationText,
} from '../../services/notifications';
import { readBody } from '../../middleware/body';
import { rateLimit } from '../../middleware/rateLimit';
import { requireAuth, requireUser } from '../../middleware/auth';
import { json, noContent } from '../../utils/response';
import { idSchema, parseOrThrow } from '../../validators/common';
import { notificationReadSchema } from '../../validators/users';
import { decodeCursor, parseLimit } from '../../utils/cursor';

const notifications = new Hono<AppContext>();

notifications.use('*', requireAuth(), async (c, next) => {
  c.header('cache-control', 'private, no-store');
  await next();
});

notifications.get('/', async (c) => {
  const viewer = requireUser(c.get('user'));
  const page = await new NotificationService(serviceContext(c)).list({
    userId: viewer.id,
    cursor: decodeCursor(c.req.query('cursor')),
    limit: parseLimit(c.req.query('limit')),
    ...(c.req.query('unread') === '1' ? { unreadOnly: true } : {}),
  });

  // Enrich with the presentation fields the client would otherwise duplicate.
  return json(c, {
    ...page,
    items: page.items.map((item) => ({
      ...item,
      text: notificationText(item),
      href: notificationHref(item),
    })),
  });
});

notifications.get('/unread-count', async (c) => {
  const viewer = requireUser(c.get('user'));
  const count = await new NotificationService(serviceContext(c)).unreadCount(viewer.id);
  return json(c, { count });
});

notifications.post('/read', rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const body = await readBody(c);
  const input = parseOrThrow(notificationReadSchema, body.fields);
  const updated = await new NotificationService(serviceContext(c)).markRead(viewer.id, input.ids);
  return json(c, { updated });
});

notifications.post('/read-all', rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  const updated = await new NotificationService(serviceContext(c)).markAllRead(viewer.id);
  return json(c, { updated });
});

notifications.delete('/:id', rateLimit('write'), async (c) => {
  const viewer = requireUser(c.get('user'));
  await new NotificationService(serviceContext(c)).remove(
    viewer.id,
    parseOrThrow(idSchema, c.req.param('id')),
  );
  return noContent();
});

export default notifications;
