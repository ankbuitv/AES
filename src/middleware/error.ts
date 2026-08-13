/**
 * Central error handling.
 *
 * Two shapes come out of here and nothing else:
 *   - `/api/*` → the JSON envelope `{success:false,data:null,error:{code,message}}`
 *   - everything else → a server-rendered error page
 *
 * Unknown throwables are logged with their real detail and reported to the
 * client as a generic 500: stack traces, SQL text and storage errors never
 * reach a browser in production. `x-error-code` is set on every failure so the
 * access log (written by the context middleware after this one) can record
 * what actually happened.
 */

import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { AppError, isAppError, statusTitle } from '../utils/errors';
import { jsonError } from '../utils/response';
import { renderErrorPage } from '../views/pages/error';
import { getConfig } from '../config';
import { createLogger } from '../utils/logger';
import type { AppContext } from '../types/env';

/** API clients get JSON; browsers navigating get HTML. */
function wantsJson(c: Context<AppContext>): boolean {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/')) return true;
  if (path === '/health') return true;
  const accept = c.req.header('accept') ?? '';
  if (accept.includes('text/html')) return false;
  return accept.includes('application/json') || c.req.header('x-requested-with') === 'fetch';
}

function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;

  // Hono's own HTTPException carries a usable status.
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = Number((err as { status: unknown }).status);
    if (Number.isFinite(status) && status >= 400 && status < 500) {
      const message = err instanceof Error ? err.message : 'Request failed';
      if (status === 401) return AppError.unauthenticated(message);
      if (status === 403) return AppError.forbidden(message);
      if (status === 404) return AppError.notFound(message);
      if (status === 413) return AppError.tooLarge(message);
      return AppError.badRequest(message);
    }
  }

  return AppError.internal('Something went wrong', err);
}

function renderError(c: Context<AppContext>, error: AppError): Response {
  c.header('x-error-code', error.code);
  // Error responses are per-request and must never be cached by a shared cache.
  c.header('cache-control', 'no-store');

  if (error.code === 'RATE_LIMITED') {
    const retryAfter = Math.max(1, Math.ceil(Number(error.details?.retryAfter ?? 60)));
    c.header('retry-after', String(retryAfter));
  }
  if (error.code === 'UNAUTHENTICATED') {
    c.header('www-authenticate', 'Cookie realm="ank"');
  }

  if (wantsJson(c)) return jsonError(c, error);

  const config = getConfig(c.env);
  const url = new URL(c.req.url);
  const body = renderErrorPage({
    status: error.status,
    title: statusTitle(error.status),
    message: error.message,
    code: error.code,
    requestId: c.get('requestId') ?? null,
    siteName: config.siteName,
    siteDescription: config.siteDescription,
    origin: config.siteUrl || url.origin,
    nonce: c.get('cspNonce') ?? '',
    csrfToken: c.get('csrfToken') ?? null,
    user: c.get('user') ?? null,
    theme: 'system',
    // Sending people to sign in is only useful when that is the problem.
    loginHref:
      error.status === 401 ? `/login?next=${encodeURIComponent(url.pathname + url.search)}` : null,
    retryAfter:
      error.code === 'RATE_LIMITED'
        ? Math.max(1, Math.ceil(Number(error.details?.retryAfter ?? 60)))
        : null,
  });

  return c.html(body, error.status as 500);
}

export const errorHandler: ErrorHandler<AppContext> = (err, c) => {
  const error = toAppError(err);

  // 5xx is a bug or an outage: log the underlying cause. 4xx is the client's
  // problem and is already visible in the access log line.
  if (error.status >= 500) {
    const logger = createLogger(getConfig(c.env).logLevel, {
      requestId: c.get('requestId') ?? 'unknown',
    });
    const cause = error.internal ?? err;
    logger.error('unhandled_error', {
      code: error.code,
      status: error.status,
      path: new URL(c.req.url).pathname,
      method: c.req.method,
      message: cause instanceof Error ? cause.message : String(cause),
      stack: cause instanceof Error ? cause.stack?.split('\n').slice(0, 5).join('\n') : undefined,
    });
  }

  return renderError(c, error);
};

export const notFoundHandler: NotFoundHandler<AppContext> = (c) => {
  return renderError(c, AppError.notFound('That page does not exist'));
};
