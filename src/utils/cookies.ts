/**
 * Cookie helpers.
 *
 * Session and CSRF cookies are written here and nowhere else, so the security
 * attributes cannot drift between routes:
 *   - HttpOnly on the session cookie (JavaScript can never read it, so an XSS
 *     bug cannot exfiltrate a login).
 *   - Secure whenever the request is HTTPS (always true in production).
 *   - SameSite=Lax, which blocks cross-site POSTs while keeping normal
 *     top-level navigation into the site logged in.
 *   - Path=/ and no Domain attribute, so the cookie stays host-only.
 */

import { CSRF_COOKIE, SESSION_COOKIE, THEME_COOKIE } from '../config';

export interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
}

/** Parse a Cookie header into a map. Malformed pairs are skipped. */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export function getCookie(request: Request, name: string): string | null {
  return parseCookies(request.headers.get('cookie'))[name] ?? null;
}

const COOKIE_NAME_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/** Serialise a Set-Cookie value. Throws on an invalid name rather than emitting a broken header. */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!COOKIE_NAME_RE.test(name)) throw new Error(`Invalid cookie name: ${name}`);

  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);

  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.trunc(options.maxAge))}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  // HttpOnly defaults to true: a cookie has to opt *out* of the safe setting.
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);

  return parts.join('; ');
}

/** True when the request arrived over HTTPS (behind Cloudflare this is the norm). */
export function isSecureRequest(request: Request): boolean {
  try {
    const url = new URL(request.url);
    if (url.protocol === 'https:') return true;
  } catch {
    /* fall through */
  }
  return (request.headers.get('x-forwarded-proto') ?? '').split(',')[0]?.trim() === 'https';
}

export function appendCookie(headers: Headers, cookie: string): void {
  headers.append('set-cookie', cookie);
}

/** Session cookie: HttpOnly, so it is unreadable from client JavaScript. */
export function sessionCookie(token: string, maxAge: number, secure: boolean): string {
  return serializeCookie(SESSION_COOKIE, token, {
    maxAge,
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
  });
}

export function clearSessionCookie(secure: boolean): string {
  return serializeCookie(SESSION_COOKIE, '', {
    maxAge: 0,
    expires: new Date(0),
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
  });
}

/**
 * CSRF cookie: deliberately readable by JavaScript so the fetch layer can echo
 * it back in the `x-csrf-token` header (double-submit pattern). It is not a
 * credential on its own — it only proves the request came from a page served
 * by this origin.
 */
export function csrfCookie(token: string, maxAge: number, secure: boolean): string {
  return serializeCookie(CSRF_COOKIE, token, {
    maxAge,
    httpOnly: false,
    secure,
    sameSite: 'Lax',
    path: '/',
  });
}

export function clearCsrfCookie(secure: boolean): string {
  return serializeCookie(CSRF_COOKIE, '', {
    maxAge: 0,
    expires: new Date(0),
    httpOnly: false,
    secure,
    sameSite: 'Lax',
    path: '/',
  });
}

/** Theme preference: no security value, read by the inline theme script. */
export function themeCookie(theme: 'light' | 'dark' | 'system', secure: boolean): string {
  return serializeCookie(THEME_COOKIE, theme, {
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    secure,
    sameSite: 'Lax',
    path: '/',
  });
}

export function readTheme(request: Request): 'light' | 'dark' | 'system' {
  const value = getCookie(request, THEME_COOKIE);
  return value === 'light' || value === 'dark' ? value : 'system';
}
