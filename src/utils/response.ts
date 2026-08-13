/**
 * The single API envelope used by every JSON endpoint:
 *   success: { success: true,  data: <T>, error: null }
 *   failure: { success: false, data: null, error: { code, message } }
 */

import type { Context } from 'hono';
import { AppError, type ErrorCode } from './errors';
import type { AppContext } from '../types/env';

export interface ApiSuccess<T> {
  success: true;
  data: T;
  error: null;
}

export interface ApiFailure {
  success: false;
  data: null;
  error: {
    code: ErrorCode | string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function ok<T>(data: T): ApiSuccess<T> {
  return { success: true, data, error: null };
}

export function fail(
  code: ErrorCode | string,
  message: string,
  details?: Record<string, unknown>,
): ApiFailure {
  return {
    success: false,
    data: null,
    error: details ? { code, message, details } : { code, message },
  };
}

/** Send a success envelope. */
export function json<T>(c: Context<AppContext>, data: T, status = 200): Response {
  return c.json(ok(data), status as 200);
}

/** Send an error envelope built from an AppError. */
export function jsonError(c: Context<AppContext>, error: AppError): Response {
  const requestId = c.get('requestId') ?? undefined;
  const safeDetails =
    error.status >= 500
      ? undefined
      : error.details;
  const body: ApiFailure = {
    success: false,
    data: null,
    error: {
      code: error.code,
      message: error.status >= 500 ? 'Something went wrong' : error.message,
      ...(requestId ? { requestId } : {}),
      ...(safeDetails ? { details: safeDetails } : {}),
    },
  };
  const res = c.json(body, error.status as 400);
  if (error.code === 'RATE_LIMITED') {
    const retryAfter = Number(error.details?.retryAfter ?? 60);
    res.headers.set('Retry-After', String(Math.max(1, Math.ceil(retryAfter))));
  }
  return res;
}

export function created<T>(c: Context<AppContext>, data: T): Response {
  return json(c, data, 201);
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}
