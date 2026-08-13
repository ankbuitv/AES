/**
 * Authorisation guards.
 *
 * The frontend never decides what a visitor may do — every protected route is
 * wrapped in one of these. They run after `sessionMiddleware`, which has
 * already resolved (or rejected) the cookie.
 */

import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types/env';
import type { AuthUser, UserRole } from '../types/models';
import { AppError } from '../utils/errors';

/** Throw unless a session is present and the account is usable. */
export function requireUser(user: AuthUser | null): AuthUser {
  if (!user) throw AppError.unauthenticated('Sign in to continue');
  if (user.status === 'suspended') {
    throw AppError.suspended('Your account is suspended, so this action is unavailable');
  }
  if (user.status === 'banned' || user.status === 'deleted') {
    throw AppError.forbidden('This account is no longer active');
  }
  return user;
}

export const requireAuth = (): MiddlewareHandler<AppContext> => {
  return async (c, next) => {
    requireUser(c.get('user'));
    await next();
  };
};

/** Role gate. Admins implicitly satisfy the `moderator` requirement. */
export const requireRole = (...roles: UserRole[]): MiddlewareHandler<AppContext> => {
  const allowed = new Set<UserRole>(roles);
  if (allowed.has('moderator')) allowed.add('admin');

  return async (c, next) => {
    const user = requireUser(c.get('user'));
    if (!allowed.has(user.role)) {
      throw AppError.forbidden('You do not have permission to access this area');
    }
    await next();
  };
};

/** Convenience for `/admin` and staff APIs. */
export const requireStaff = (): MiddlewareHandler<AppContext> => requireRole('moderator', 'admin');
export const requireAdmin = (): MiddlewareHandler<AppContext> => requireRole('admin');

/**
 * Reject signed-in visitors (login/register pages). Redirects browsers, and
 * returns a JSON conflict for API clients.
 */
export const requireGuest = (redirectTo = '/'): MiddlewareHandler<AppContext> => {
  return async (c, next) => {
    if (c.get('user')) {
      if (c.req.header('accept')?.includes('text/html')) return c.redirect(redirectTo, 302);
      throw AppError.conflict('You are already signed in');
    }
    await next();
  };
};
