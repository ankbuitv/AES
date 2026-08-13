/**
 * Typed application errors. Every error surfaced to a client goes through
 * `AppError`, which guarantees a stable machine-readable `code` and a message
 * that is safe to show. Internal details stay in `internal` and are logged, but
 * never serialised into a response.
 */

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'CSRF_FAILED'
  | 'ACCOUNT_SUSPENDED'
  | 'REGISTRATION_CLOSED'
  | 'STORAGE_ERROR'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  INVALID_INPUT: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  CSRF_FAILED: 403,
  ACCOUNT_SUSPENDED: 403,
  REGISTRATION_CLOSED: 403,
  STORAGE_ERROR: 502,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Extra machine-readable context that IS safe to return (e.g. field errors). */
  readonly details?: Record<string, unknown>;
  /** Never serialised — logged only. */
  readonly internal?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    options: { status?: number; details?: Record<string, unknown>; internal?: unknown } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? STATUS_BY_CODE[code] ?? 500;
    this.details = options.details;
    this.internal = options.internal;
  }

  static badRequest(message = 'Invalid request', details?: Record<string, unknown>) {
    return new AppError('INVALID_INPUT', message, { details });
  }

  static unauthenticated(message = 'Authentication required') {
    return new AppError('UNAUTHENTICATED', message);
  }

  static forbidden(message = 'You do not have permission to do that') {
    return new AppError('FORBIDDEN', message);
  }

  static notFound(message = 'Not found') {
    return new AppError('NOT_FOUND', message);
  }

  static conflict(message = 'Already exists', details?: Record<string, unknown>) {
    return new AppError('CONFLICT', message, { details });
  }

  static rateLimited(retryAfterSeconds: number, message = 'Too many requests') {
    return new AppError('RATE_LIMITED', message, {
      details: { retryAfter: retryAfterSeconds },
    });
  }

  static tooLarge(message = 'Payload too large', details?: Record<string, unknown>) {
    return new AppError('PAYLOAD_TOO_LARGE', message, { details });
  }

  static unsupportedMedia(message = 'Unsupported file type', details?: Record<string, unknown>) {
    return new AppError('UNSUPPORTED_MEDIA_TYPE', message, { details });
  }

  static csrf(message = 'CSRF validation failed') {
    return new AppError('CSRF_FAILED', message);
  }

  static suspended(message = 'This account is suspended', details?: Record<string, unknown>) {
    return new AppError('ACCOUNT_SUSPENDED', message, { details });
  }

  static registrationClosed(message = 'Registration is currently closed') {
    return new AppError('REGISTRATION_CLOSED', message);
  }

  static unavailable(message = 'Service temporarily unavailable', internal?: unknown) {
    return new AppError('SERVICE_UNAVAILABLE', message, { internal });
  }

  static storage(message = 'Storage backend error', internal?: unknown) {
    return new AppError('STORAGE_ERROR', message, { internal });
  }

  static internal(message = 'Something went wrong', internal?: unknown) {
    return new AppError('INTERNAL_ERROR', message, { internal });
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** HTTP status → the copy used by SSR error pages. */
export function statusTitle(status: number): string {
  switch (status) {
    case 400:
      return 'Bad request';
    case 401:
      return 'Sign in required';
    case 403:
      return 'Access denied';
    case 404:
      return 'Page not found';
    case 413:
      return 'Too large';
    case 415:
      return 'Unsupported file';
    case 429:
      return 'Slow down';
    case 503:
      return 'Temporarily unavailable';
    case 502:
      return 'Something went wrong';
    default:
      return 'Something went wrong';
  }
}
