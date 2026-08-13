/**
 * Authentication API.
 *
 * Every mutation here is rate-limited, CSRF-protected (applied by the parent
 * router) and validated before it reaches the service. Session tokens are set
 * as HttpOnly cookies — they are never returned in a response body, so a
 * successful login leaves nothing for injected JavaScript to steal.
 */

import { Hono } from 'hono';
import type { AppContext } from '../../types/env';
import { serviceContext } from '../../services/context';
import { AuthService } from '../../services/auth';
import { readBody } from '../../middleware/body';
import { rateLimit } from '../../middleware/rateLimit';
import { requireAuth, requireUser } from '../../middleware/auth';
import { json, noContent } from '../../utils/response';
import { parseOrThrow } from '../../validators/common';
import {
  changePasswordSchema,
  confirmPasswordResetSchema,
  deleteAccountSchema,
  loginSchema,
  registerSchema,
  requestPasswordResetSchema,
} from '../../validators/auth';
import {
  clearCsrfCookie,
  clearSessionCookie,
  csrfCookie,
  isSecureRequest,
  sessionCookie,
} from '../../utils/cookies';
import { issueCsrfToken, CSRF_TTL } from '../../utils/csrf';
import { resolveSessionSecret } from '../../config';
import type { AuthResult } from '../../services/auth';
import type { Context } from 'hono';
import { now } from '../../utils/time';

const auth = new Hono<AppContext>();

function fingerprint(c: Context<AppContext>) {
  return {
    ip: c.get('clientIp'),
    userAgent: c.req.header('user-agent') ?? '',
  };
}

/**
 * Attach the session cookie and rotate the CSRF token onto the new session
 * scope. Rotating here is what prevents a token minted for the anonymous
 * scope from remaining valid after privilege changes.
 */
async function establishSession(c: Context<AppContext>, result: AuthResult): Promise<void> {
  const secure = isSecureRequest(c.req.raw);
  const maxAge = Math.max(60, result.session.expiresAt - now());

  c.header('set-cookie', sessionCookie(result.session.token, maxAge, secure), { append: true });

  const token = await issueCsrfToken(resolveSessionSecret(c.env), result.session.sessionId);
  c.header('set-cookie', csrfCookie(token, CSRF_TTL, secure), { append: true });
  c.set('csrfToken', token);
  c.set('user', result.user);
  c.set('sessionId', result.session.sessionId);
}

function publicAuthPayload(result: AuthResult, csrfToken: string | null) {
  return {
    user: {
      id: result.user.id,
      username: result.user.username,
      displayName: result.user.displayName,
      role: result.user.role,
      level: result.user.level,
      xp: result.user.xp,
      avatarMediaId: result.user.avatarMediaId,
    },
    awardedBadges: result.awardedBadges,
    csrfToken,
    expiresAt: result.session.expiresAt,
  };
}

auth.post('/register', rateLimit('register'), async (c) => {
  const body = await readBody(c);
  const input = parseOrThrow(registerSchema, body.fields);

  const service = new AuthService(serviceContext(c));
  const result = await service.register({
    username: input.username,
    email: input.email,
    password: input.password,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    fingerprint: fingerprint(c),
  });

  await establishSession(c, result);
  return json(c, publicAuthPayload(result, c.get('csrfToken')), 201);
});

auth.post('/login', rateLimit('login'), async (c) => {
  const body = await readBody(c);
  const input = parseOrThrow(loginSchema, body.fields);

  const service = new AuthService(serviceContext(c));
  const result = await service.login({
    identifier: input.identifier,
    password: input.password,
    fingerprint: fingerprint(c),
    currentSessionId: c.get('sessionId'),
  });

  await establishSession(c, result);
  return json(c, publicAuthPayload(result, c.get('csrfToken')));
});

auth.post('/logout', async (c) => {
  const sessionId = c.get('sessionId');
  if (sessionId) await new AuthService(serviceContext(c)).logout(sessionId);

  const secure = isSecureRequest(c.req.raw);
  c.header('set-cookie', clearSessionCookie(secure), { append: true });
  c.header('set-cookie', clearCsrfCookie(secure), { append: true });
  c.set('user', null);
  c.set('sessionId', null);
  return json(c, { loggedOut: true });
});

auth.post('/logout-all', requireAuth(), async (c) => {
  const user = requireUser(c.get('user'));
  const count = await new AuthService(serviceContext(c)).logoutEverywhere(user.id);

  const secure = isSecureRequest(c.req.raw);
  c.header('set-cookie', clearSessionCookie(secure), { append: true });
  c.header('set-cookie', clearCsrfCookie(secure), { append: true });
  return json(c, { revoked: count });
});

/** Explicit sliding-window extension, used by the client before long idles. */
auth.post('/refresh', requireAuth(), async (c) => {
  const sessionId = c.get('sessionId');
  if (!sessionId) return json(c, { expiresAt: null });

  const expiresAt = await new AuthService(serviceContext(c)).refresh(sessionId);
  return json(c, { expiresAt });
});

auth.get('/me', async (c) => {
  const user = c.get('user');
  if (!user) return json(c, { user: null, csrfToken: c.get('csrfToken') });
  return json(c, {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      role: user.role,
      status: user.status,
      level: user.level,
      xp: user.xp,
      avatarMediaId: user.avatarMediaId,
      createdAt: user.createdAt,
    },
    csrfToken: c.get('csrfToken'),
  });
});

auth.get('/sessions', requireAuth(), async (c) => {
  const user = requireUser(c.get('user'));
  const sessions = await new AuthService(serviceContext(c)).listSessions(user.id, c.get('sessionId'));
  return json(c, { sessions });
});

auth.delete('/sessions/:id', requireAuth(), async (c) => {
  const user = requireUser(c.get('user'));
  await new AuthService(serviceContext(c)).revokeSession(user.id, c.req.param('id'));
  return noContent();
});

auth.post('/password', requireAuth(), async (c) => {
  const user = requireUser(c.get('user'));
  const body = await readBody(c);
  const input = parseOrThrow(changePasswordSchema, body.fields);

  await new AuthService(serviceContext(c)).changePassword({
    userId: user.id,
    currentPassword: input.currentPassword,
    newPassword: input.newPassword,
    currentSessionId: c.get('sessionId'),
  });
  return json(c, { changed: true });
});

/**
 * Always reports success: telling an anonymous caller whether an address is
 * registered would turn this endpoint into an account-enumeration oracle.
 */
auth.post('/password/reset', rateLimit('passwordReset'), async (c) => {
  const body = await readBody(c);
  const input = parseOrThrow(requestPasswordResetSchema, body.fields);

  const result = await new AuthService(serviceContext(c)).requestPasswordReset(input.email);
  return json(c, {
    requested: true,
    delivered: result.delivered,
    // Only ever populated outside production — see AuthService.
    ...(result.token ? { devToken: result.token } : {}),
  });
});

auth.post('/password/reset/confirm', rateLimit('passwordReset'), async (c) => {
  const body = await readBody(c);
  const input = parseOrThrow(confirmPasswordResetSchema, body.fields);

  await new AuthService(serviceContext(c)).confirmPasswordReset(input);

  const secure = isSecureRequest(c.req.raw);
  c.header('set-cookie', clearSessionCookie(secure), { append: true });
  return json(c, { reset: true });
});

auth.post('/delete-account', requireAuth(), async (c) => {
  const user = requireUser(c.get('user'));
  const body = await readBody(c);
  const input = parseOrThrow(deleteAccountSchema, body.fields);

  await new AuthService(serviceContext(c)).deleteAccount({
    userId: user.id,
    password: input.password,
  });

  const secure = isSecureRequest(c.req.raw);
  c.header('set-cookie', clearSessionCookie(secure), { append: true });
  c.header('set-cookie', clearCsrfCookie(secure), { append: true });
  return json(c, { deleted: true });
});

export default auth;
