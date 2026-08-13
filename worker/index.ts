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
import { checkStorageHealth } from '../src/services/storageFactory';
import { checkSchema, ensureSchema } from '../src/db/schema';
import { randomToken } from '../src/utils/id';
import { getConfig } from '../src/config';

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
  const config = getConfig(c.env);
  const ctx = buildServiceContext({
    env: c.env,
    request: c.req.raw,
    requestId: c.get('requestId') ?? randomToken(8),
  });

  // Apply pending migrations before probing so a freshly-created D1 becomes
  // usable on the first health check after deploy.
  const schemaApply = await ensureSchema(c.env.DB).catch(() => null);

  const [db, storage, schema] = await Promise.all([
    ctx.repos.db
      .scalar<number>('SELECT 1')
      .then(() => 'ok' as const)
      .catch(() => 'error' as const),
    checkStorageHealth(c.env)
      .then((result) => (result.ok ? ('ok' as const) : ('error' as const)))
      .catch(() => 'error' as const),
    checkSchema(c.env.DB)
      .then((result) => result.status)
      .catch(() => 'error' as const),
  ]);

  c.header('cache-control', 'no-store');
  return c.json({
    status: 'ok',
    environment: config.environment,
    version: 1,
    checks: { database: db, storage, schema },
    schema: schemaApply
      ? { ready: schemaApply.ready, applied: schemaApply.applied.length, pending: schemaApply.pending.length }
      : undefined,
    timestamp: new Date().toISOString(),
  });
});

app.route('/api', api);
app.route('/media', mediaRoute);
app.route('/', seo);
app.route('/', staticPages);
app.route('/', pages);

export default {
  fetch: app.fetch,

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
        .then(() => runScheduled(serviceCtx, event.cron))
        .catch((error: unknown) => {
          serviceCtx.logger.error('scheduled_failed', {
            cron: event.cron,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
    );
  },
};
