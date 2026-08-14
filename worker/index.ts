/**
 * Worker entrypoint.
 *
 * One Hono app serves everything: the JSON API (`/api/*`), the media gateway
 * (`/media/*`), the crawler endpoints and the server-rendered HTML pages.
 * Static files are served by the Workers Assets binding.
 *
 * The middleware order below is deliberate and is the security backbone of the
 * whole application:
 *   1. requestContext  — request id, CSP nonce, client ip, access log
 *   2. securityHeaders — CSP/HSTS/nosniff/referrer/permissions on every reply
 *   3. sessionMiddleware — resolves the session cookie, mints the CSRF token
 * Anything mounted afterwards can rely on all three being in place. Body-size
 * limits, CSRF verification and rate limiting are applied inside the routers
 * that need them.
 */

import { Hono } from 'hono';
import type { AppContext, Bindings, WorkerContext } from '../src/types/env';
import {
  errorHandler,
  notFoundHandler,
  requestContext,
  securityHeaders,
  sessionMiddleware,
} from '../src/middleware';
import api from '../src/routes/api';
import mediaRoute from '../src/routes/media';
import pages from '../src/routes/pages';
import seo from '../src/routes/pages/seo';
import staticPages from '../src/routes/pages/static';
import { buildServiceContext } from '../src/services/context';
import { runScheduled } from '../src/services/jobs';
import { collectHealthReport } from '../src/services/health';
import { recordStatusSnapshot } from '../src/services/statusHistory';
import { ensureSchema } from '../src/db/schema';
import { randomToken } from '../src/utils/id';
import { handleConversationSocket } from './socket';

export { ConversationRoom } from './durable/conversationRoom';

const app = new Hono<AppContext>();

app.onError(errorHandler);
app.notFound(notFoundHandler);

app.use('*', requestContext(), securityHeaders(), sessionMiddleware());

/**
 * Liveness/readiness probe.
 *
 * Always returns `{"status":"ok"}` with 200 when the Worker itself is healthy;
 * dependency state is reported alongside it so a failing bucket or database is
 * visible without taking the endpoint down (and without leaking any config).
 */
app.get('/health', async (c) => {
  const report = await collectHealthReport(c.env);
  c.header('cache-control', 'no-store');
  return c.json(report);
});

app.route('/api', api);
app.route('/media', mediaRoute);
app.route('/', seo);
app.route('/', staticPages);
app.route('/', pages);

export default {
  /**
   * The WebSocket upgrade is answered before Hono sees the request: Hono
   * re-wraps responses and would strip the `webSocket` property off the 101.
   * `handleConversationSocket` returns null for every other request, so the
   * normal pipeline is untouched.
   */
  async fetch(request: Request, env: Bindings, ctx: WorkerContext): Promise<Response> {
    const upgraded = await handleConversationSocket(request, env);
    if (upgraded) return upgraded;
    return app.fetch(request, env, ctx as ExecutionContext);
  },

  /**
   * Cron Triggers. The schedule string selects the frequent or nightly task
   * set; see `runScheduled`.
   */
  async scheduled(
    event: { cron: string; scheduledTime: number },
    env: Bindings,
    ctx: WorkerContext,
  ): Promise<void> {
    const serviceCtx = buildServiceContext({
      env,
      request: new Request(env.SITE_URL || 'https://worker.local/'),
      executionCtx: ctx,
      requestId: `cron-${randomToken(8)}`,
    });

    ctx.waitUntil(
      ensureSchema(env.DB)
        .then(async () => {
          const health = await collectHealthReport(env);
          await Promise.all([
            runScheduled(serviceCtx, event.cron),
            recordStatusSnapshot(env, health).catch((error: unknown) => {
              serviceCtx.logger.warn('status_history_failed', {
                error: error instanceof Error ? error.message : String(error),
              });
            }),
          ]);
        })
        .catch((error: unknown) => {
          serviceCtx.logger.error('scheduled_failed', {
            cron: event.cron,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
    );
  },
};
