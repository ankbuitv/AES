/**
 * Schema bootstrap.
 *
 * Production D1 is created empty. Cloudflare Workers Builds runs
 * `wrangler deploy` and does **not** apply `migrations/`. This module is the
 * reproducible fallback: it applies the same SQL files Wrangler would, tracks
 * them in `d1_migrations` (the table Wrangler itself uses), and is a no-op
 * once the schema is present.
 *
 * It never invents DDL. The only statements executed are those in
 * `/migrations/*.sql`.
 */

import { BUNDLED_MIGRATIONS } from './bundledMigrations';

export interface SchemaStatus {
  ok: boolean;
  ready: boolean;
  applied: string[];
  pending: string[];
  error?: string;
}

const CORE_TABLES = ['settings', 'categories', 'tags', 'users', 'posts', 'media', 'notifications'] as const;

/** Per-binding cache: after a successful ensure, later requests on the same D1 skip work. */
const readyDbs = new WeakSet<D1Database>();
const inflight = new WeakMap<D1Database, Promise<SchemaStatus>>();

export function resetSchemaCache(): void {
  /* WeakSet/WeakMap cannot be cleared; tests use distinct D1 instances. */
}

export function isSchemaReady(d1?: D1Database): boolean {
  return d1 ? readyDbs.has(d1) : false;
}

function prepareMigrationSql(sql: string): string {
  // D1Database.exec rejects a chunk whose first line is a standalone SQL
  // comment ("SQL code did not contain a statement"). Wrangler's migration
  // runner accepts the same files, so remove line comments before handing the
  // bundled fallback to D1. PRAGMAs are connection-scoped and unsupported by
  // the remote exec endpoint; the schema does not depend on them.
  return sql
    .replace(/--[^\r\n]*/g, '')
    .replace(/^\s*PRAGMA\b[^;]*;\s*$/gim, '')
    // D1 exec treats each newline as a separate query. Collapse formatting so
    // multiline CREATE TABLE / TRIGGER statements are submitted intact.
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
}

async function tableExists(d1: D1Database, name: string): Promise<boolean> {
  try {
    const row = await d1
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .bind(name)
      .first<{ name: string }>();
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

const TRACKING_TABLE = 'aes_schema_migrations';

async function listApplied(d1: D1Database): Promise<string[]> {
  const names = new Set<string>();
  // Honour Wrangler-applied migrations when that table already exists, but
  // never try to create `d1_migrations` ourselves — local Wrangler intercepts
  // that DDL and the remote table is owned by the migrate CLI.
  for (const table of ['d1_migrations', TRACKING_TABLE]) {
    try {
      const result = await d1.prepare(`SELECT name FROM ${table}`).all<{ name: string }>();
      for (const row of result.results ?? []) {
        if (row.name) names.add(row.name);
      }
    } catch {
      /* table does not exist yet */
    }
  }
  return [...names];
}

async function ensureTrackingTable(d1: D1Database): Promise<void> {
  await d1
    .prepare(
      `CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`,
    )
    .run();
}

async function recordApplied(d1: D1Database, name: string): Promise<void> {
  await d1
    .prepare(`INSERT OR IGNORE INTO ${TRACKING_TABLE} (name, applied_at) VALUES (?, ?)`)
    .bind(name, Math.floor(Date.now() / 1000))
    .run();
}

async function applyOne(d1: D1Database, name: string, sql: string): Promise<void> {
  const body = prepareMigrationSql(sql);
  if (body) await d1.exec(body);
  await recordApplied(d1, name);
}

async function inspect(d1: D1Database): Promise<{ applied: string[]; hasCore: boolean }> {
  const [applied, hasCore] = await Promise.all([
    listApplied(d1),
    tableExists(d1, 'posts'),
  ]);
  return { applied, hasCore };
}

/**
 * Apply any migrations that have not yet been recorded.
 *
 * If the core tables already exist (tests, or a database migrated outside
 * Wrangler's tracker) we only backfill `d1_migrations` — we do not re-run DDL.
 */
async function applyPending(d1: D1Database): Promise<SchemaStatus> {
  try {
    await ensureTrackingTable(d1);
    const { applied, hasCore } = await inspect(d1);
    const appliedSet = new Set(applied);
    const pending = BUNDLED_MIGRATIONS.filter((m) => !appliedSet.has(m.name));

    if (!pending.length) {
      if (hasCore) readyDbs.add(d1);
      return { ok: hasCore, ready: hasCore, applied, pending: [] };
    }

    if (hasCore && pending.length) {
      // Core tables exist (partial Wrangler apply, older deploy). Still run
      // pending files: every bundled migration is CREATE IF NOT EXISTS, so
      // this backfills missing tables like `blocks` instead of only stamping
      // the tracker and leaving logged-in feeds broken.
      const newly: string[] = [];
      for (const migration of pending) {
        try {
          await applyOne(d1, migration.name, migration.sql);
          newly.push(migration.name);
        } catch {
          await recordApplied(d1, migration.name);
          newly.push(migration.name);
        }
      }
      readyDbs.add(d1);
      return {
        ok: true,
        ready: true,
        applied: [...applied, ...newly],
        pending: [],
      };
    }

    const newly: string[] = [];
    for (const migration of pending) {
      await applyOne(d1, migration.name, migration.sql);
      newly.push(migration.name);
    }

    const coreOk = await tableExists(d1, 'posts');
    if (coreOk) readyDbs.add(d1);
    return {
      ok: coreOk,
      ready: coreOk,
      applied: [...applied, ...newly],
      pending: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      ready: false,
      applied: [],
      pending: BUNDLED_MIGRATIONS.map((m) => m.name),
      error: message.slice(0, 300),
    };
  }
}

/** Idempotent. Concurrent callers on the same binding share one in-flight apply. */
export async function ensureSchema(d1: D1Database): Promise<SchemaStatus> {
  if (readyDbs.has(d1)) {
    return { ok: true, ready: true, applied: BUNDLED_MIGRATIONS.map((m) => m.name), pending: [] };
  }
  const existing = inflight.get(d1);
  if (existing) return existing;
  const pending = applyPending(d1).finally(() => {
    inflight.delete(d1);
  });
  inflight.set(d1, pending);
  return pending;
}

/** Cheap readiness probe used by /health. Does not apply anything. */
export async function checkSchema(d1: D1Database): Promise<{
  status: 'ok' | 'missing' | 'error';
  tables: string[];
  applied: number;
  expected: number;
}> {
  try {
    const applied = await listApplied(d1);
    const present: string[] = [];
    for (const name of CORE_TABLES) {
      if (await tableExists(d1, name)) present.push(name);
    }
    const status = present.length === CORE_TABLES.length ? 'ok' : present.length === 0 ? 'missing' : 'error';
    return {
      status,
      tables: present,
      applied: applied.length,
      expected: BUNDLED_MIGRATIONS.length,
    };
  } catch {
    return { status: 'error', tables: [], applied: 0, expected: BUNDLED_MIGRATIONS.length };
  }
}

export function isMissingRelationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table/i.test(message) || /no such column/i.test(message);
}

export { BUNDLED_MIGRATIONS, CORE_TABLES };
