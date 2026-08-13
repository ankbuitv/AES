/**
 * Request body handling.
 *
 * Two jobs:
 *
 *  1. **Size caps.** A Worker that buffers an unbounded body burns memory and
 *     CPU for free, so the declared `Content-Length` is checked before the
 *     body is touched, and the actual bytes are re-checked while reading.
 *     JSON/form bodies use `MAX_JSON_BODY_BYTES`; multipart uploads use
 *     `MAX_UPLOAD_BYTES` plus a small allowance for part headers.
 *
 *  2. **Parse once.** CSRF validation needs the `_csrf` field of an HTML form
 *     post, and the route handler needs the same body afterwards. Streams can
 *     only be read once, so the parsed body is memoised per request and both
 *     layers read from the cache.
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { AppContext } from '../types/env';
import { AppError } from '../utils/errors';
import { getConfig } from '../config';

export type ParsedBodyKind = 'json' | 'form' | 'multipart' | 'empty';

export interface ParsedBody {
  kind: ParsedBodyKind;
  /** Scalar fields, flattened. Files are excluded — see `files`. */
  fields: Record<string, unknown>;
  /** Only populated for multipart requests. */
  files: Record<string, File>;
}

const cache = new WeakMap<object, Promise<ParsedBody>>();

/** Extra bytes allowed on top of the file cap for multipart boundaries/headers. */
const MULTIPART_OVERHEAD = 8 * 1024;

function limitForRequest(c: Context<AppContext>): number {
  const config = getConfig(c.env);
  const type = (c.req.header('content-type') ?? '').toLowerCase();
  if (type.startsWith('multipart/form-data')) {
    return config.maxUploadBytes + MULTIPART_OVERHEAD;
  }
  return config.maxJsonBodyBytes;
}

/**
 * Reject oversized requests up front. Cheap: it only inspects headers, which
 * means a hostile 1 GB upload is refused before a single byte is buffered.
 */
export const bodyLimit = (): MiddlewareHandler<AppContext> => {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

    const declared = Number(c.req.header('content-length') ?? '0');
    const max = limitForRequest(c);
    if (Number.isFinite(declared) && declared > max) {
      throw AppError.tooLarge(
        `Request body is larger than the ${Math.floor(max / 1024)} KB limit for this endpoint`,
        { limit: max },
      );
    }
    await next();
  };
};

/**
 * Parse (once) and return the request body. Safe to call from several layers.
 * Unknown content types yield an empty body rather than throwing, so a route
 * can validate the shape it actually expects.
 */
export function readBody(c: Context<AppContext>): Promise<ParsedBody> {
  const key = c.req.raw as unknown as object;
  const existing = cache.get(key);
  if (existing) return existing;

  const promise = parse(c);
  cache.set(key, promise);
  return promise;
}

async function parse(c: Context<AppContext>): Promise<ParsedBody> {
  const method = c.req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return { kind: 'empty', fields: {}, files: {} };

  const contentType = (c.req.header('content-type') ?? '').toLowerCase();
  const max = limitForRequest(c);

  if (contentType.startsWith('application/json')) {
    const text = await readTextCapped(c.req.raw, max);
    if (!text.trim()) return { kind: 'json', fields: {}, files: {} };
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw AppError.badRequest('Request body must be a JSON object');
      }
      return { kind: 'json', fields: parsed as Record<string, unknown>, files: {} };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw AppError.badRequest('Request body is not valid JSON');
    }
  }

  if (contentType.startsWith('application/x-www-form-urlencoded')) {
    const text = await readTextCapped(c.req.raw, max);
    const params = new URLSearchParams(text);
    const fields: Record<string, unknown> = {};
    for (const [key, value] of params) collect(fields, key, value);
    return { kind: 'form', fields, files: {} };
  }

  if (contentType.startsWith('multipart/form-data')) {
    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      throw AppError.badRequest('Malformed multipart body');
    }
    const fields: Record<string, unknown> = {};
    const files: Record<string, File> = {};
    let bytes = 0;
    for (const [key, value] of form) {
      if (typeof value === 'string') {
        collect(fields, key, value);
      } else {
        bytes += value.size;
        if (bytes > max) throw AppError.tooLarge('Upload exceeds the maximum allowed size');
        files[key] = value;
      }
    }
    return { kind: 'multipart', fields, files };
  }

  return { kind: 'empty', fields: {}, files: {} };
}

/** Repeated keys become arrays (`tags=a&tags=b`), matching HTML form semantics. */
function collect(target: Record<string, unknown>, key: string, value: string): void {
  const normalised = key.endsWith('[]') ? key.slice(0, -2) : key;
  const existing = target[normalised];
  if (existing === undefined) {
    target[normalised] = key.endsWith('[]') ? [value] : value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    target[normalised] = [existing, value];
  }
}

/**
 * Read a body as text while enforcing a hard byte cap, even when the client
 * lied about (or omitted) Content-Length.
 */
async function readTextCapped(request: Request, max: number): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        throw AppError.tooLarge('Request body is too large', { limit: max });
      }
      chunks.push(value);
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
