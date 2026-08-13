/**
 * Shared Zod schemas and parsing helpers.
 *
 * Every request body, query string and path parameter is parsed through these
 * before reaching a service. Failures become a 400 with per-field details.
 */

import { z } from 'zod';
import { AppError } from '../utils/errors';
import { LIMITS } from '../config';

export const idSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid identifier');

/** Usernames that would collide with an application route. */
export const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'system', 'support', 'help', 'api', 'auth',
  'login', 'logout', 'register', 'signup', 'signin', 'settings', 'search',
  'explore', 'trending', 'following', 'notifications', 'media', 'post', 'posts',
  'user', 'users', 'u', 'tag', 'tags', 'about', 'terms', 'privacy', 'static',
  'assets', 'public', 'health', 'robots', 'sitemap', 'moderator', 'mod',
  'anksocial', 'ank', 'null', 'undefined', 'me', 'you',
]);

/**
 * Username *format* only. Used when reading a `:username` route parameter:
 * an account may legitimately hold a name that new registrations can no
 * longer claim (a reserved word added later, or one created by the admin
 * script), and its profile must still be reachable.
 */
export const usernameParamSchema = z
  .string()
  .trim()
  .min(LIMITS.usernameMin, `Username must be at least ${LIMITS.usernameMin} characters`)
  .max(LIMITS.usernameMax, `Username must be at most ${LIMITS.usernameMax} characters`)
  .regex(/^[a-zA-Z0-9_]+$/, 'Username may only contain letters, numbers and underscores')
  .transform((v) => v.toLowerCase());

/** Username for *registration*: format plus the reserved-word blocklist. */
export const usernameSchema = usernameParamSchema.refine(
  (v) => !RESERVED_USERNAMES.has(v),
  'That username is reserved',
);

export const emailSchema = z
  .string()
  .trim()
  .min(5)
  .max(254)
  .email('Enter a valid email address')
  .transform((v) => v.toLowerCase());

export const passwordSchema = z
  .string()
  .min(LIMITS.passwordMin, `Password must be at least ${LIMITS.passwordMin} characters`)
  .max(LIMITS.passwordMax, 'Password is too long')
  .refine((v) => /[a-z]/i.test(v), 'Password must contain a letter')
  .refine((v) => /[0-9]/.test(v) || /[^a-zA-Z0-9]/.test(v), 'Password must contain a number or symbol');

export const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9-]+$/, 'Invalid slug');

export const cursorSchema = z.string().max(256).optional();

export const limitSchema = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : Number(v)))
  .refine((v) => v === undefined || (Number.isFinite(v) && v >= 1 && v <= 50), {
    message: 'limit must be between 1 and 50',
  });

/**
 * A URL we are willing to render as a link.
 *
 * `z.string().url()` accepts every scheme, including `javascript:` and
 * `data:`, so it is not sufficient on its own: anything user-supplied that
 * ends up in an `href` must be restricted to http(s) here as well as escaped
 * at render time.
 */
export const httpUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Enter a valid http(s) URL');

export const visibilitySchema = z.enum(['public', 'followers', 'private']);
export const reactionTypeSchema = z.enum(['like', 'love', 'insightful', 'funny', 'sad']);
export const reactionTargetSchema = z.enum(['post', 'comment']);


/**
 * Parse a value with a schema, converting ZodError into AppError('INVALID_INPUT')
 * with a field→message map that is safe to show the user.
 */
export function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const path = issue.path.join('.') || '_';
      if (!fields[path]) fields[path] = issue.message;
    }
    const first = Object.values(fields)[0] ?? 'Invalid request';
    throw AppError.badRequest(first, { fields });
  }
  return result.data;
}

/** Reject strings containing characters that only appear in injection attempts. */
export function assertNoControlChars(value: string, field = 'input'): void {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw AppError.badRequest(`${field} contains invalid characters`);
  }
}

/** Collapse whitespace runs and trim — used for titles and display names. */
export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
