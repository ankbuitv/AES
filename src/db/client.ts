/**
 * Thin D1 helper.
 *
 * Every query in the codebase goes through these functions, and they only
 * accept `(sql, params[])` — string concatenation of user values is impossible
 * by construction, so SQL injection is prevented structurally rather than by
 * review.
 */

import { AppError } from '../utils/errors';

export type SqlParam = string | number | null | ArrayBuffer;

export class Db {
  constructor(private readonly d1: D1Database) {}

  /** Fetch a single row, or null. */
  async first<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T | null> {
    try {
      return await this.d1
        .prepare(sql)
        .bind(...params)
        .first<T>();
    } catch (error) {
      throw wrap(error, sql);
    }
  }

  /** Fetch all rows. */
  async all<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    try {
      const result = await this.d1
        .prepare(sql)
        .bind(...params)
        .all<T>();
      return result.results ?? [];
    } catch (error) {
      throw wrap(error, sql);
    }
  }

  /** Execute a write, returning row counts. */
  async run(
    sql: string,
    params: SqlParam[] = [],
  ): Promise<{ changes: number; lastRowId: number | null }> {
    try {
      const result = await this.d1
        .prepare(sql)
        .bind(...params)
        .run();
      return {
        changes: result.meta?.changes ?? 0,
        lastRowId: result.meta?.last_row_id ?? null,
      };
    } catch (error) {
      throw wrap(error, sql);
    }
  }

  /** Single scalar value (COUNT, SUM, EXISTS...). */
  async scalar<T = number>(sql: string, params: SqlParam[] = []): Promise<T | null> {
    const row = await this.first<Record<string, T>>(sql, params);
    if (!row) return null;
    const values = Object.values(row);
    return (values[0] ?? null) as T | null;
  }

  /**
   * Atomic multi-statement write.
   *
   * D1's `batch()` runs every statement inside one implicit transaction and
   * rolls the whole batch back if any statement fails — this is the correct
   * primitive for Workers, because interactive BEGIN/COMMIT is not available
   * over the D1 HTTP protocol.
   */
  async batch<T = Record<string, unknown>>(
    statements: { sql: string; params?: SqlParam[] }[],
  ): Promise<D1Result<T>[]> {
    if (!statements.length) return [];
    try {
      const prepared = statements.map(({ sql, params }) =>
        this.d1.prepare(sql).bind(...(params ?? [])),
      );
      return await this.d1.batch<T>(prepared);
    } catch (error) {
      throw wrap(error, statements[0]?.sql ?? 'batch');
    }
  }

  /** Escape-hatch for callers that need the raw binding (migrations, admin). */
  get raw(): D1Database {
    return this.d1;
  }
}

function wrap(error: unknown, sql: string): AppError {
  const message = error instanceof Error ? error.message : String(error);

  // Map common SQLite constraint failures onto domain errors so routes can
  // return a sensible status instead of a 500.
  if (/UNIQUE constraint failed/i.test(message)) {
    return AppError.conflict('That already exists', { constraint: extractConstraint(message) });
  }
  if (/FOREIGN KEY constraint failed/i.test(message)) {
    return AppError.badRequest('Referenced record does not exist');
  }
  if (/CHECK constraint failed/i.test(message)) {
    return AppError.badRequest('Value is not allowed');
  }

  return AppError.internal('Database error', { sql: sql.slice(0, 200), message });
}

function extractConstraint(message: string): string {
  const match = /UNIQUE constraint failed:\s*([^\s(]+)/i.exec(message);
  return match?.[1] ?? '';
}

/** Build `(?, ?, ?)` placeholder lists for IN clauses. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}
