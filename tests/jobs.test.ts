/**
 * Background work: the durable job queue and the scheduled maintenance run.
 *
 * The Worker's `scheduled()` handler is invoked directly, exactly as a Cron
 * Trigger would, so the tasks are covered end to end.
 */

import { describe, expect, it } from 'vitest';
import worker from '../worker/index';
import { createTestEnv, TINY_PNG } from './helpers/env';
import { TestClient } from './helpers/client';
import { buildServiceContext } from '../src/services/context';
import { JobRunner, runScheduled } from '../src/services/jobs';

function executionCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise.catch(() => undefined));
      },
      passThroughOnException() {},
    } as unknown as ExecutionContext,
    settle: () => Promise.all(pending),
  };
}

function contextFor(bindings: ReturnType<typeof createTestEnv>['bindings']) {
  return buildServiceContext({
    env: bindings,
    request: new Request('http://localhost:8787/'),
    requestId: 'test-cron',
  });
}

describe('job queue', () => {
  it('claims a batch, runs it and marks it done', async () => {
    const env = createTestEnv();
    const ctx = contextFor(env.bindings);

    await ctx.repos.jobs.enqueue('storage_cleanup', {});
    await ctx.repos.jobs.enqueue('stats_rollup', { dayStart: Math.floor(Date.now() / 1000) - 86400 });

    const result = await new JobRunner(ctx).drain(10);
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);

    const remaining = env.db.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'`)
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('retries a failing job with backoff instead of losing it', async () => {
    const env = createTestEnv();
    const ctx = contextFor(env.bindings);

    // A media_variants job for a row that does not exist is a no-op, so force
    // a genuine failure through the storage layer instead.
    await ctx.repos.jobs.enqueue('notification_fanout', {
      items: [{ userId: 'usr_missing', actorId: 'usr_other', type: 'SYSTEM', targetType: 'post', targetId: 'pst_x' }],
    });

    const result = await new JobRunner(ctx).drain(10);
    expect(result.failed).toBe(1);

    const row = env.db.sqlite
      .prepare('SELECT status, attempts, run_after, last_error FROM jobs LIMIT 1')
      .get() as { status: string; attempts: number; run_after: number; last_error: string };

    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.run_after).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(row.last_error).toBeTruthy();
  });

  it('ignores an unknown job type rather than looping forever', async () => {
    const env = createTestEnv();
    const ctx = contextFor(env.bindings);
    await ctx.repos.jobs.enqueue('not_a_real_job', {});

    const result = await new JobRunner(ctx).drain(10);
    expect(result.processed).toBe(1);
  });
});

describe('scheduled maintenance', () => {
  it('purges expired sessions on the frequent schedule', async () => {
    const client = new TestClient();
    await client.register({ username: 'stale' });
    client.env.db.sqlite.exec('UPDATE sessions SET expires_at = 1, absolute_expiry = 1');

    const ctx = contextFor(client.bindings);
    const report = await runScheduled(ctx, '*/15 * * * *');

    expect(report.sessionsPurged).toBeGreaterThan(0);
    const left = client.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get() as {
      n: number;
    };
    expect(left.n).toBe(0);
  });

  it('drains the storage cleanup queue and removes the objects', async () => {
    const client = new TestClient();
    await client.register({ username: 'cleaner' });

    const upload = await client.upload<{ media: { id: string } }>('/api/media/upload', {
      name: 'pixel.png',
      type: 'image/png',
      bytes: TINY_PNG,
    });
    const id = upload.body.data!.media.id;
    const key = (
      client.env.db.sqlite.prepare('SELECT storage_key FROM media WHERE id = ?').get(id) as {
        storage_key: string;
      }
    ).storage_key;

    await client.delete(`/api/media/${id}`);

    // Deleting enqueues the object for removal; the queue row exists whether
    // or not the opportunistic post-response drain has already run.
    const enqueued = client.env.db.sqlite
      .prepare('SELECT COUNT(*) AS n FROM storage_cleanup_queue WHERE storage_key = ?')
      .get(key) as { n: number };
    expect(enqueued.n).toBe(1);

    const ctx = contextFor(client.bindings);
    await runScheduled(ctx, '*/15 * * * *');

    const queued = client.env.db.sqlite
      .prepare('SELECT COUNT(*) AS n FROM storage_cleanup_queue WHERE processed_at IS NULL')
      .get() as { n: number };
    expect(queued.n).toBe(0);
    // The bucket object is gone too, not just the queue row.
    expect(client.env.storage.objects.has(key)).toBe(false);
  });

  it('aggregates yesterday and reconciles counters on the nightly schedule', async () => {
    const client = new TestClient();
    await client.register({ username: 'aggregate' });
    await client.post('/api/posts', { content: 'counted' });

    // Corrupt a denormalised counter; the nightly job must repair it.
    client.env.db.sqlite.exec('UPDATE users SET post_count = 99');

    const ctx = contextFor(client.bindings);
    const report = await runScheduled(ctx, '27 3 * * *');

    expect(report.statsDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(report.countersReconciled).toBeGreaterThan(0);

    const user = client.env.db.sqlite
      .prepare('SELECT post_count FROM users WHERE username = ?')
      .get('aggregate') as { post_count: number };
    expect(user.post_count).toBe(1);

    const stats = client.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM stats_daily').get() as {
      n: number;
    };
    expect(stats.n).toBeGreaterThan(0);
  });

  it('runs through the Worker scheduled() entrypoint', async () => {
    const env = createTestEnv();
    const { ctx, settle } = executionCtx();

    await worker.scheduled(
      { cron: '*/15 * * * *', scheduledTime: Date.now() },
      env.bindings,
      ctx as unknown as Parameters<typeof worker.scheduled>[2],
    );
    await settle();

    // Nothing to do on an empty database, but it must not throw.
    expect(true).toBe(true);
  });

  it('keeps going when one task fails', async () => {
    const client = new TestClient();
    await client.register({ username: 'resilient' });

    // Break the storage provider; session purging must still happen.
    client.env.db.sqlite.exec('UPDATE sessions SET expires_at = 1, absolute_expiry = 1');
    client.env.storage.failNext = new Error('bucket down');

    const ctx = contextFor(client.bindings);
    const report = await runScheduled(ctx, '27 3 * * *');

    expect(report.sessionsPurged).toBeGreaterThan(0);
    expect(report.statsDay).toBeTruthy();
  });
});
