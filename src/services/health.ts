/**
 * Shared dependency probes for the JSON health endpoint and the public status
 * page. Keeping the probes in one place prevents the human and machine views
 * from disagreeing about whether AES is ready to serve traffic.
 */

import type { Bindings } from '../types/env';
import { BUNDLED_MIGRATIONS, checkSchema, ensureSchema } from '../db/schema';
import { checkStorageHealth } from './storageFactory';

export type HealthCheckState = 'ok' | 'error' | 'missing';
export type ReadinessState = 'ready' | 'degraded' | 'not_ready';

export interface HealthReport {
  /** Worker liveness. This deliberately remains `ok` when a dependency fails. */
  status: 'ok';
  readiness: ReadinessState;
  environment: 'development' | 'preview' | 'production';
  version: 1;
  checks: {
    database: 'ok' | 'error';
    storage: 'ok' | 'error';
    schema: HealthCheckState;
  };
  schema: {
    ready: boolean;
    applied: number;
    pending: number;
  };
  latencyMs: {
    database: number;
    storage: number;
    schema: number;
    total: number;
  };
  timestamp: string;
}

interface TimedResult<T> {
  value: T;
  duration: number;
}

async function timed<T>(work: () => Promise<T>): Promise<TimedResult<T>> {
  const started = Date.now();
  const value = await work();
  return { value, duration: Math.max(0, Date.now() - started) };
}

export function readinessFor(checks: HealthReport['checks']): ReadinessState {
  if (checks.database !== 'ok' || checks.schema !== 'ok') return 'not_ready';
  if (checks.storage !== 'ok') return 'degraded';
  return 'ready';
}

/**
 * Apply pending migrations, then probe D1, object storage and the resulting
 * schema concurrently. Errors are converted to public states here; callers do
 * not receive provider messages, SQL text or credentials.
 */
export async function collectHealthReport(env: Bindings): Promise<HealthReport> {
  const started = Date.now();

  const schemaApply = await ensureSchema(env.DB).catch(() => ({
    ok: false,
    ready: false,
    applied: [] as string[],
    pending: BUNDLED_MIGRATIONS.map((migration) => migration.name),
  }));

  const [databaseProbe, storageProbe, schemaProbe] = await Promise.all([
    timed(async () => {
      try {
        await env.DB.prepare('SELECT 1 AS ok').first();
        return 'ok' as const;
      } catch {
        return 'error' as const;
      }
    }),
    timed(async () => {
      try {
        const result = await checkStorageHealth(env);
        return result.ok ? ('ok' as const) : ('error' as const);
      } catch {
        return 'error' as const;
      }
    }),
    timed(async () => {
      try {
        return (await checkSchema(env.DB)).status;
      } catch {
        return 'error' as const;
      }
    }),
  ]);

  const checks: HealthReport['checks'] = {
    database: databaseProbe.value,
    storage: storageProbe.value,
    schema: schemaProbe.value,
  };

  return {
    status: 'ok',
    readiness: readinessFor(checks),
    environment: env.ENVIRONMENT ?? 'development',
    version: 1,
    checks,
    schema: {
      ready: schemaApply.ready,
      applied: schemaApply.applied.length,
      pending: schemaApply.pending.length,
    },
    latencyMs: {
      database: databaseProbe.duration,
      storage: storageProbe.duration,
      schema: schemaProbe.duration,
      total: Math.max(0, Date.now() - started),
    },
    timestamp: new Date().toISOString(),
  };
}
