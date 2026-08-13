/**
 * In-memory D1 implementation backed by `node:sqlite`.
 *
 * The tests exercise the real repositories, services and routes against real
 * SQL with the real migrations applied — no mocked database, no fake query
 * layer. `node:sqlite` is the same SQLite engine D1 is built on and ships with
 * FTS5, so even the search provider is covered.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type Param = string | number | null | ArrayBuffer | Uint8Array;

function normalise(value: Param): string | number | null | Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value as string | number | null | Uint8Array;
}

/** Plain objects: `node:sqlite` returns null-prototype rows. */
function plain<T>(row: unknown): T {
  return { ...(row as Record<string, unknown>) } as T;
}

class FakeStatement {
  private params: Param[] = [];

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...params: Param[]): this {
    this.params = params;
    return this;
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params.map(normalise));
    if (row === undefined) return null;
    const object = plain<Record<string, unknown>>(row);
    if (column) return (object[column] ?? null) as T;
    return object as T;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, number> }> {
    const rows = this.db.prepare(this.sql).all(...this.params.map(normalise));
    return { results: rows.map((row) => plain<T>(row)), success: true, meta: {} };
  }

  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const result = this.db.prepare(this.sql).run(...this.params.map(normalise));
    return {
      success: true,
      meta: {
        changes: Number(result.changes ?? 0),
        last_row_id: Number(result.lastInsertRowid ?? 0),
      },
    };
  }

  async raw<T>(): Promise<T[]> {
    const rows = this.db.prepare(this.sql).all(...this.params.map(normalise));
    return rows.map((row) => Object.values(plain<Record<string, unknown>>(row))) as T[];
  }
}

export class FakeD1 {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.db, sql);
  }

  async batch<T>(statements: FakeStatement[]): Promise<{ results: T[]; success: true }[]> {
    // D1 runs a batch inside one implicit transaction; mirror that so tests
    // observe the same rollback behaviour on failure.
    this.db.exec('BEGIN');
    try {
      const out: { results: T[]; success: true }[] = [];
      for (const statement of statements) {
        const result = await statement.all<T>();
        out.push({ results: result.results, success: true });
      }
      this.db.exec('COMMIT');
      return out;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error('dump() is not supported by the test harness');
  }

  withSession(): FakeD1 {
    return this;
  }

  /** Escape hatch for assertions that need direct SQL. */
  get sqlite(): DatabaseSync {
    return this.db;
  }
}

/**
 * Split a migration file into statements.
 *
 * `node:sqlite`'s `exec()` handles multiple statements, but CREATE TRIGGER
 * bodies contain semicolons, so the file is executed as a whole and only split
 * when that fails (which never happens with the shipped migrations, but keeps
 * the harness robust).
 */
export function createEmptyDatabase(): FakeD1 {
  return new FakeD1(new DatabaseSync(':memory:'));
}

export function createTestDatabase(): FakeD1 {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');

  const dir = path.join(root, 'migrations');
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = readFileSync(path.join(dir, file), 'utf8');
    db.exec(sql);
  }

  return new FakeD1(db);
}

/** Minimal KV namespace: enough for the rate limiter and the B2 token cache. */
export class FakeKV {
  private readonly store = new Map<string, { value: string; expiresAt: number | null }>();

  async get(key: string, type?: 'text' | 'json'): Promise<unknown> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return type === 'json' ? JSON.parse(entry.value) : entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(): Promise<{ keys: { name: string }[]; list_complete: true }> {
    return { keys: [...this.store.keys()].map((name) => ({ name })), list_complete: true };
  }

  clear(): void {
    this.store.clear();
  }
}
