/**
 * CSRF protection.
 *
 * Two independent checks must both pass on every state-changing request:
 *
 *  1. **Origin check** — `Origin`/`Referer` must match the site's own origin.
 *     This alone stops the vast majority of cross-site form posts.
 *  2. **Signed double-submit token** — the browser sends the token twice: in a
 *     JS-readable cookie and in the `x-csrf-token` header (or a hidden form
 *     field). An attacker's page can force a request but cannot read our
 *     cookie to populate the header, and cannot forge the signature because
 *     the token is HMAC'd with `SESSION_SECRET`.
 *
 * The token is bound to the session id, so a token minted for an anonymous
 * visitor cannot be replayed after login (and vice versa).
 */

import { hmacSha256Hex, timingSafeEqualString } from './crypto';
import { randomToken } from './id';
import { AppError } from './errors';
import { now } from './time';

/** Methods that never mutate state and therefore skip the CSRF check. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const CSRF_HEADER = 'x-csrf-token';
export const CSRF_FIELD = '_csrf';
/** Tokens are valid for 12 hours; a page open longer than that must refresh. */
export const CSRF_TTL = 60 * 60 * 12;

/**
 * Issue a token of the form `nonce.issuedAt.signature`.
 * `scope` is the session id, or a stable anonymous marker for logged-out
 * visitors (login and register forms need CSRF too).
 */
export async function issueCsrfToken(secret: string, scope: string): Promise<string> {
  const nonce = randomToken(16);
  const issuedAt = now();
  const signature = await sign(secret, scope, nonce, issuedAt);
  return `${nonce}.${issuedAt}.${signature}`;
}

/** Verify a token's signature, scope binding and age. */
export async function verifyCsrfToken(
  secret: string,
  scope: string,
  token: string | null | undefined,
): Promise<boolean> {
  if (!token || token.length > 256) return false;

  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const [nonce, issuedAtRaw, signature] = parts as [string, string, string];
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt)) return false;

  const age = now() - issuedAt;
  if (age < -60 || age > CSRF_TTL) return false;

  const expected = await sign(secret, scope, nonce, issuedAt);
  return timingSafeEqualString(signature, expected);
}

async function sign(
  secret: string,
  scope: string,
  nonce: string,
  issuedAt: number,
): Promise<string> {
  return hmacSha256Hex(secret, `csrf:${scope}:${nonce}:${issuedAt}`);
}

/**
 * Origin validation. Returns true when the request demonstrably came from our
 * own origin, or when there is nothing to check (same-origin GETs from older
 * clients omit both headers).
 */
export function isSameOrigin(request: Request, allowedOrigins: string[]): boolean {
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  const candidate = origin ?? referer;

  // A state-changing request with no Origin and no Referer is refused: every
  // modern browser sends Origin on POST.
  if (!candidate) return false;

  let candidateOrigin: string;
  try {
    candidateOrigin = new URL(candidate).origin;
  } catch {
    return false;
  }
  return allowedOrigins.some((allowed) => {
    try {
      return new URL(allowed).origin === candidateOrigin;
    } catch {
      return false;
    }
  });
}

export function requiresCsrfCheck(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

export interface CsrfCheckInput {
  request: Request;
  secret: string;
  scope: string;
  allowedOrigins: string[];
  /** Token from the header, or from the parsed form body for HTML form posts. */
  submittedToken: string | null;
  cookieToken: string | null;
}

/**
 * Full check for a mutating request. Throws `AppError.forbidden` with a
 * `CSRF_FAILED` code on any failure — the caller does not need to branch.
 */
export async function assertCsrf(input: CsrfCheckInput): Promise<void> {
  if (!requiresCsrfCheck(input.request.method)) return;

  if (!isSameOrigin(input.request, input.allowedOrigins)) {
    throw AppError.csrf('Request origin is not allowed');
  }

  const submitted = input.submittedToken;
  if (!submitted) throw AppError.csrf('Missing CSRF token');

  // Double submit: header/field value must equal the cookie value…
  if (!input.cookieToken || !timingSafeEqualString(submitted, input.cookieToken)) {
    throw AppError.csrf('CSRF token mismatch');
  }
  // …and the value must carry our signature for this session scope.
  if (!(await verifyCsrfToken(input.secret, input.scope, submitted))) {
    throw AppError.csrf('CSRF token is invalid or expired');
  }
}

/** Scope used for visitors without a session (login/register forms). */
export const ANONYMOUS_SCOPE = 'anon';
