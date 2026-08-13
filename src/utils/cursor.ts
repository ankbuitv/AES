/**
 * Cursor pagination.
 *
 * Feeds never use OFFSET: a cursor encodes the sort keys of the last row seen
 * — `(sortValue, id)` — so the next page is a pure index range scan whose cost
 * does not grow with page depth.
 *
 * Cursors are opaque base64url payloads. They are not secret and not signed:
 * they only ever narrow a WHERE clause that is already scoped by the caller's
 * permissions, and every field is re-validated on decode.
 */

import { base64UrlDecode, base64UrlEncode } from './id';
import { AppError } from './errors';

export interface Cursor {
  /** Primary sort value: unix seconds, a score, or a count. */
  v: number;
  /** Tie-breaker: the row id. */
  i: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeCursor(cursor: Cursor): string {
  return base64UrlEncode(encoder.encode(`${cursor.v}|${cursor.i}`));
}

export function decodeCursor(value: string | undefined | null): Cursor | null {
  if (!value) return null;
  if (value.length > 256) throw AppError.badRequest('Invalid cursor');
  try {
    const text = decoder.decode(base64UrlDecode(value));
    const sep = text.indexOf('|');
    if (sep <= 0) throw new Error('malformed');
    const v = Number(text.slice(0, sep));
    const i = text.slice(sep + 1);
    if (!Number.isFinite(v) || !i || i.length > 64 || !/^[A-Za-z0-9_-]+$/.test(i)) {
      throw new Error('malformed');
    }
    return { v, i };
  } catch {
    throw AppError.badRequest('Invalid cursor');
  }
}

export const MIN_LIMIT = 1;
export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 15;

/** Clamp a user-supplied `limit` into the allowed 1..50 range. */
export function parseLimit(value: string | undefined | null, fallback = DEFAULT_LIMIT): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw AppError.badRequest('limit must be a number');
  const int = Math.trunc(n);
  if (int < MIN_LIMIT || int > MAX_LIMIT) {
    throw AppError.badRequest(`limit must be between ${MIN_LIMIT} and ${MAX_LIMIT}`);
  }
  return int;
}

/**
 * Build a page from `limit + 1` rows: the extra row tells us whether more
 * exist, without a COUNT query.
 */
export function buildPage<Row, Item>(
  rows: Row[],
  limit: number,
  mapItem: (row: Row) => Item,
  makeCursor: (row: Row) => Cursor,
): { items: Item[]; nextCursor: string | null; hasMore: boolean } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(mapItem),
    nextCursor: hasMore && last ? encodeCursor(makeCursor(last)) : null,
    hasMore,
  };
}
