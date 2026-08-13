/** Status monitoring history and incident transitions. */

import { describe, expect, it } from 'vitest';
import { collectHealthReport, type HealthReport } from '../src/services/health';
import {
  loadStatusHistory,
  recordStatusSnapshot,
  STATUS_HISTORY_KEY,
} from '../src/services/statusHistory';
import { createTestEnv } from './helpers/env';

function at(report: HealthReport, timestamp: string): HealthReport {
  return { ...report, timestamp };
}

describe('status monitoring', () => {
  it('records daily availability and resolves an outage incident', async () => {
    const env = createTestEnv();
    const healthy = await collectHealthReport(env.bindings);
    const start = '2026-08-13T08:00:00.000Z';

    await recordStatusSnapshot(env.bindings, at(healthy, start));

    const outage: HealthReport = {
      ...healthy,
      readiness: 'degraded',
      checks: { ...healthy.checks, storage: 'error' },
      timestamp: '2026-08-13T08:15:00.000Z',
    };
    await recordStatusSnapshot(env.bindings, outage);
    await recordStatusSnapshot(env.bindings, at(healthy, '2026-08-13T08:30:00.000Z'));

    const history = await loadStatusHistory(env.bindings);
    expect(history.days).toHaveLength(1);
    expect(history.days[0]?.checks.storage).toEqual({ ok: 2, total: 3 });
    expect(history.days[0]?.checks.database).toEqual({ ok: 3, total: 3 });
    expect(history.incidents).toHaveLength(1);
    expect(history.incidents[0]?.affected).toEqual(['storage']);
    expect(history.incidents[0]?.resolvedAt).toBe('2026-08-13T08:30:00.000Z');
  });

  it('keeps a bounded 90-day history in one KV record', async () => {
    const env = createTestEnv();
    const healthy = await collectHealthReport(env.bindings);
    const start = new Date('2026-05-01T00:00:00.000Z');

    for (let offset = 0; offset < 95; offset++) {
      const timestamp = new Date(start);
      timestamp.setUTCDate(start.getUTCDate() + offset);
      await recordStatusSnapshot(env.bindings, at(healthy, timestamp.toISOString()));
    }

    const history = await loadStatusHistory(env.bindings);
    expect(history.days).toHaveLength(90);
    expect(history.days[0]?.date).toBe('2026-05-06');
    expect((await env.kv.get(STATUS_HISTORY_KEY, 'text')) as string).toContain('"version":1');
  });
});
