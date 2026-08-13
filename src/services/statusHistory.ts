/**
 * Lightweight Upptime-style history stored in KV.
 *
 * Cron records one sample every 15 minutes. Samples are rolled into daily
 * counters, so 90 days of honest availability data stays small and the status
 * page needs one KV read rather than 90. Unknown days remain unknown — the UI
 * never fabricates uptime for time before monitoring began.
 */

import type { Bindings } from '../types/env';
import type { HealthCheckState, HealthReport } from './health';

export const STATUS_HISTORY_KEY = 'status:history:v1';
const HISTORY_DAYS = 90;
const MAX_INCIDENTS = 30;

export type StatusComponentKey = 'edge' | 'database' | 'storage' | 'schema';

export interface StatusAggregate {
  ok: number;
  total: number;
}

export interface StatusDay {
  /** UTC date, YYYY-MM-DD. */
  date: string;
  updatedAt: string;
  checks: Record<StatusComponentKey, StatusAggregate>;
}

export interface StatusIncident {
  id: string;
  startedAt: string;
  resolvedAt?: string;
  affected: StatusComponentKey[];
}

export interface StatusHistory {
  version: 1;
  days: StatusDay[];
  incidents: StatusIncident[];
}

function emptyHistory(): StatusHistory {
  return { version: 1, days: [], incidents: [] };
}

function aggregate(): StatusAggregate {
  return { ok: 0, total: 0 };
}

function emptyDay(date: string, updatedAt: string): StatusDay {
  return {
    date,
    updatedAt,
    checks: {
      edge: aggregate(),
      database: aggregate(),
      storage: aggregate(),
      schema: aggregate(),
    },
  };
}

function validAggregate(value: unknown): value is StatusAggregate {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<StatusAggregate>;
  return (
    typeof row.ok === 'number' &&
    Number.isFinite(row.ok) &&
    row.ok >= 0 &&
    typeof row.total === 'number' &&
    Number.isFinite(row.total) &&
    row.total >= row.ok
  );
}

function validDay(value: unknown): value is StatusDay {
  if (!value || typeof value !== 'object') return false;
  const day = value as Partial<StatusDay>;
  if (typeof day.date !== 'string' || typeof day.updatedAt !== 'string' || !day.checks) return false;
  return (['edge', 'database', 'storage', 'schema'] as const).every((key) =>
    validAggregate(day.checks?.[key]),
  );
}

function validIncident(value: unknown): value is StatusIncident {
  if (!value || typeof value !== 'object') return false;
  const incident = value as Partial<StatusIncident>;
  const components: readonly string[] = ['edge', 'database', 'storage', 'schema'];
  return (
    typeof incident.id === 'string' &&
    typeof incident.startedAt === 'string' &&
    (incident.resolvedAt === undefined || typeof incident.resolvedAt === 'string') &&
    Array.isArray(incident.affected) &&
    incident.affected.every((key) => components.includes(key))
  );
}

function parseHistory(value: unknown): StatusHistory {
  if (!value || typeof value !== 'object') return emptyHistory();
  const candidate = value as Partial<StatusHistory>;
  if (candidate.version !== 1 || !Array.isArray(candidate.days) || !Array.isArray(candidate.incidents)) {
    return emptyHistory();
  }
  return {
    version: 1,
    days: candidate.days.filter(validDay),
    incidents: candidate.incidents.filter(validIncident),
  };
}

export async function loadStatusHistory(env: Bindings): Promise<StatusHistory> {
  try {
    const value = await env.KV.get(STATUS_HISTORY_KEY, 'json');
    return parseHistory(value);
  } catch {
    // Status history is supplemental. A KV problem must never hide the live
    // status that can still be obtained directly from D1/storage probes.
    return emptyHistory();
  }
}

function stateIsOk(state: HealthCheckState): boolean {
  return state === 'ok';
}

function affectedComponents(report: HealthReport): StatusComponentKey[] {
  const affected: StatusComponentKey[] = [];
  if (report.checks.database !== 'ok') affected.push('database');
  if (report.checks.storage !== 'ok') affected.push('storage');
  if (report.checks.schema !== 'ok') affected.push('schema');
  return affected;
}

function incidentId(timestamp: string): string {
  return `inc-${timestamp.replace(/[^0-9]/g, '').slice(0, 14)}`;
}

/** Record one cron sample and update incident transitions. */
export async function recordStatusSnapshot(env: Bindings, report: HealthReport): Promise<void> {
  const history = await loadStatusHistory(env);
  const date = report.timestamp.slice(0, 10);
  let day = history.days.find((entry) => entry.date === date);
  if (!day) {
    day = emptyDay(date, report.timestamp);
    history.days.push(day);
  }

  const states: Record<StatusComponentKey, HealthCheckState> = {
    edge: 'ok',
    database: report.checks.database,
    storage: report.checks.storage,
    schema: report.checks.schema,
  };

  for (const key of ['edge', 'database', 'storage', 'schema'] as const) {
    day.checks[key].total += 1;
    if (stateIsOk(states[key])) day.checks[key].ok += 1;
  }
  day.updatedAt = report.timestamp;

  const affected = affectedComponents(report);
  const open = history.incidents.find((incident) => !incident.resolvedAt);
  if (affected.length) {
    if (open) {
      open.affected = [...new Set([...open.affected, ...affected])];
    } else {
      history.incidents.unshift({
        id: incidentId(report.timestamp),
        startedAt: report.timestamp,
        affected,
      });
    }
  } else if (open) {
    open.resolvedAt = report.timestamp;
  }

  const cutoff = new Date(report.timestamp);
  cutoff.setUTCDate(cutoff.getUTCDate() - (HISTORY_DAYS - 1));
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  history.days = history.days
    .filter((entry) => entry.date >= cutoffDate)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-HISTORY_DAYS);
  history.incidents = history.incidents.slice(0, MAX_INCIDENTS);

  await env.KV.put(STATUS_HISTORY_KEY, JSON.stringify(history));
}
