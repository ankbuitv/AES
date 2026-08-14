/**
 * `/api/*` router.
 *
 * Cross-cutting concerns are applied once, here, so no individual handler can
 * forget them:
 *   - body size limit (before any parsing)
 *   - CSRF for every state-changing method
 *   - a JSON `Vary`/no-index posture appropriate to an API
 *
 * Authentication itself is resolved further up (the root app runs the session
 * middleware for both HTML and API routes); individual routers add
 * `requireAuth()`/`requireStaff()` where needed.
 */

import { Hono } from 'hono';
import type { AppContext } from '../../types/env';
import { bodyLimit } from '../../middleware/body';
import { csrfProtection } from '../../middleware/csrf';
import { json } from '../../utils/response';

import auth from './auth';
import posts from './posts';
import comments from './comments';
import users, { me } from './users';
import media from './media';
import notifications from './notifications';
import search, { categories, tags } from './search';
import admin, { reports } from './admin';
import extras from './extras';
import messages from './messages';
import reels from './reels';

const api = new Hono<AppContext>();

api.use('*', bodyLimit(), csrfProtection(), async (c, next) => {
  await next();
  // API responses must never be indexed and must vary on the session cookie.
  c.header('x-robots-tag', 'noindex');
  const vary = c.res.headers.get('vary');
  c.header('vary', vary ? `${vary}, Cookie` : 'Cookie');
});

api.route('/auth', auth);
api.route('/posts', posts);
api.route('/comments', comments);
api.route('/users', users);
api.route('/me', me);
api.route('/media', media);
api.route('/notifications', notifications);
api.route('/search', search);
api.route('/tags', tags);
api.route('/categories', categories);
api.route('/reports', reports);
api.route('/admin', admin);
api.route('/community', extras);
api.route('/messages', messages);
api.route('/reels', reels);

/**
 * Small discovery document. Useful for smoke-testing a fresh deployment
 * (`curl https://host/api`) without exposing anything sensitive.
 */
api.get('/', (c) => {
  c.header('cache-control', 'public, max-age=0, s-maxage=300');
  return json(c, {
    name: 'AES API',
    version: 1,
    endpoints: [
      '/api/auth',
      '/api/posts',
      '/api/comments',
      '/api/users',
      '/api/me',
      '/api/media',
      '/api/notifications',
      '/api/search',
      '/api/tags',
      '/api/categories',
      '/api/reports',
      '/api/admin',
      '/api/community',
      '/api/messages',
      '/api/reels',
    ],
  });
});

export default api;
