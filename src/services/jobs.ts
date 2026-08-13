/**
 * Background work: the durable job queue and the scheduled maintenance run.
 *
 * Cloudflare Queues are a paid add-on, so the shipped implementation is a
 * durable D1-backed queue (`jobs` table) drained by a Cron Trigger every 15
 * minutes and opportunistically after requests. The producer side already goes
 * through `repos.jobs.enqueue()`, so switching to a real Queue binding later
 * means changing this file only — see `dispatch()`.
 *
 * Every task is defensive: one failing job must not abort the whole run, and a
 * failed job is retried with exponential backoff (five attempts, then parked
 * as `failed` for inspection).
 */

import type { ServiceContext } from './context';
import { MediaService } from './media';
import { dayKey, now } from '../utils/time';

export type JobType = 'notification_fanout' | 'media_variants' | 'storage_cleanup' | 'stats_rollup';

interface JobRow {
  id: string;
  type: string;
  payload_json: string;
  attempts: number;
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class JobRunner {
  constructor(private readonly ctx: ServiceContext) {}

  /** Claim and execute up to `limit` pending jobs. */
  async drain(limit = 25): Promise<{ processed: number; failed: number }> {
    const batch = (await this.ctx.repos.jobs.takeBatch(limit)) as JobRow[];
    let processed = 0;
    let failed = 0;

    for (const job of batch) {
      try {
        await this.dispatch(job.type, parsePayload(job.payload_json));
        await this.ctx.repos.jobs.complete(job.id);
        processed++;
      } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : String(error);
        this.ctx.logger.warn('job_failed', { type: job.type, attempts: job.attempts, error: message });
        await this.ctx.repos.jobs.fail(job.id, message, job.attempts);
      }
    }

    return { processed, failed };
  }

  private async dispatch(type: string, payload: Record<string, unknown>): Promise<void> {
    switch (type) {
      case 'notification_fanout': {
        const items = Array.isArray(payload.items) ? payload.items : [];
        if (!items.length) return;
        // Chunked so a very large fan-out stays inside the D1 batch limit.
        for (let i = 0; i < items.length; i += 50) {
          await this.ctx.repos.notifications.createMany(
            items.slice(i, i + 50) as Parameters<
              typeof this.ctx.repos.notifications.createMany
            >[0],
          );
        }
        return;
      }

      case 'media_variants': {
        const mediaId = typeof payload.mediaId === 'string' ? payload.mediaId : '';
        if (!mediaId) return;
        await new MediaService(this.ctx).generateVariants(mediaId);
        return;
      }

      case 'storage_cleanup': {
        await new MediaService(this.ctx).drainCleanupQueue(25);
        return;
      }

      case 'stats_rollup': {
        const dayStart =
          typeof payload.dayStart === 'number'
            ? payload.dayStart
            : Math.floor(now() / 86400) * 86400 - 86400;
        await this.ctx.repos.stats.aggregateDay(dayStart);
        return;
      }

      case 'publish_scheduled': {
        const due = await this.ctx.repos.extras.dueScheduled(25);
        for (const row of due) {
          await this.ctx.repos.extras.publishScheduled(row.id);
        }
        return;
      }

      case 'email_digest': {
        const users = await this.ctx.repos.extras.usersWantingDigest();
        for (const user of users) {
          const since = user.digest_last_at ?? now() - 86400;
          const posts = await this.ctx.repos.extras.recentPublicPostsSince(since, 6);
          if (!posts.length) continue;
          await this.ctx.repos.notifications.createMany([
            {
              userId: user.user_id,
              actorId: null,
              type: 'SYSTEM',
              targetType: 'digest',
              targetId: String(now()),
              data: {
                title: `${posts.length} new posts`,
                body: posts.map((p) => p.title || p.excerpt).join(' · ').slice(0, 240),
              },
            },
          ]);
          await this.ctx.repos.extras.markDigestSent(user.user_id);
        }
        return;
      }

      default:
        this.ctx.logger.warn('job_unknown_type', { type });
    }
  }
}

export interface MaintenanceReport {
  cron: string;
  jobs?: { processed: number; failed: number };
  sessionsPurged?: number;
  authTokensPurged?: number;
  cleanup?: { deleted: number; failed: number };
  orphans?: number;
  integrity?: { checked: number; missing: number };
  countersReconciled?: number;
  statsDay?: string;
  jobsPurged?: number;
  errors?: string[];
}

/** Run a task and record, but never rethrow, its failure. */
async function safely<T>(
  errors: string[],
  label: string,
  work: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Cron entrypoint.
 *
 * Two schedules are configured in wrangler.toml:
 *   - `*​/15 * * * *` — frequent: drain jobs, purge expired sessions, flush the
 *     storage cleanup queue.
 *   - `27 3 * * *`  — nightly: aggregate yesterday's stats, collect orphaned
 *     media, verify storage integrity, reconcile denormalised counters.
 */
export async function runScheduled(ctx: ServiceContext, cron: string): Promise<MaintenanceReport> {
  const errors: string[] = [];
  const report: MaintenanceReport = { cron };
  const nightly = cron.startsWith('27 3') || cron === 'nightly';

  report.jobs = await safely(errors, 'jobs', () => new JobRunner(ctx).drain(nightly ? 50 : 25));
  await safely(errors, 'scheduled_posts', async () => {
    const due = await ctx.repos.extras.dueScheduled(40);
    for (const row of due) await ctx.repos.extras.publishScheduled(row.id);
  });
  if (nightly) {
    await safely(errors, 'digest', () => ctx.repos.jobs.enqueue('email_digest', {}));
  }
  report.sessionsPurged = await safely(errors, 'sessions', () =>
    ctx.repos.sessions.purgeExpired(1000),
  );
  report.cleanup = await safely(errors, 'storage_cleanup', () =>
    new MediaService(ctx).drainCleanupQueue(nightly ? 100 : 25),
  );

  if (nightly) {
    const media = new MediaService(ctx);
    const yesterday = Math.floor(now() / 86400) * 86400 - 86400;

    report.authTokensPurged = await safely(errors, 'auth_tokens', () =>
      ctx.repos.sessions.purgeExpiredAuthTokens(),
    );
    report.orphans = await safely(errors, 'orphans', () => media.collectOrphans());
    report.integrity = await safely(errors, 'integrity', () => media.verifyIntegrity(25));
    report.countersReconciled = await safely(errors, 'counters', () =>
      ctx.repos.users.reconcileCounters(500),
    );
    await safely(errors, 'stats', async () => {
      await ctx.repos.stats.aggregateDay(yesterday);
      report.statsDay = dayKey(yesterday);
    });
    report.jobsPurged = await safely(errors, 'jobs_purge', () =>
      ctx.repos.jobs.purgeDone(now() - 7 * 86400),
    );
  }

  if (errors.length) report.errors = errors;

  ctx.logger.info('scheduled_run', report as unknown as Record<string, unknown>);
  return report;
}
