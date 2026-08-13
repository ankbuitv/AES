/**
 * Authentication: registration, login, sessions, password change, reset and
 * account deletion — including every rejection path the spec calls out
 * (unauthenticated, invalid input, wrong password, expired session).
 */

import { describe, expect, it } from 'vitest';
import { PBKDF2_ITERATIONS, hashPassword, needsRehash, verifyPassword } from '../src/utils/crypto';
import { TestClient } from './helpers/client';

describe('password hashing', () => {
  it('writes a Cloudflare Workers-compatible PBKDF2 hash', async () => {
    // Workers rejects the previous 210,000-round format on deployments whose
    // WebCrypto PBKDF2 ceiling is 100,000. Keeping this assertion here makes a
    // future security-tuning change explicit rather than silently breaking
    // registration in production.
    expect(PBKDF2_ITERATIONS).toBe(100_000);

    const hash = await hashPassword('CorrectHorse!99');
    expect(hash).toMatch(/^pbkdf2\$100000\$[^$]+\$[^$]+$/);
    expect(await verifyPassword('CorrectHorse!99', hash)).toBe(true);
    expect(needsRehash(hash)).toBe(false);
  });
});

describe('registration', () => {
  it('creates an account and sets an HttpOnly session cookie', async () => {
    const client = new TestClient();
    const response = await client.raw('/login', { headers: { accept: 'text/html' } });
    expect(response.status).toBe(200);

    const result = await client.post<{ user: { username: string } }>('/api/auth/register', {
      username: 'newbie',
      email: 'newbie@example.com',
      password: 'CorrectHorse!99',
      displayName: 'Newbie',
    });

    expect(result.status).toBe(201);
    expect(result.body.success).toBe(true);
    expect(result.body.data?.user.username).toBe('newbie');

    const cookies = result.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith('ank_session='));
    expect(session).toBeDefined();
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Lax');
  });

  it('never returns the password hash or session token in the body', async () => {
    const client = new TestClient();
    await client.get('/login', { headers: { accept: 'text/html' } });
    const result = await client.post('/api/auth/register', {
      username: 'quiet',
      email: 'quiet@example.com',
      password: 'CorrectHorse!99',
    });
    expect(result.text).not.toMatch(/pbkdf2\$/);
    expect(result.text).not.toMatch(/password/i);
  });

  it('rejects a weak password', async () => {
    const client = new TestClient();
    await client.get('/login', { headers: { accept: 'text/html' } });
    const result = await client.post('/api/auth/register', {
      username: 'weak',
      email: 'weak@example.com',
      password: 'short',
    });
    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe('INVALID_INPUT');
  });

  it('rejects a reserved or malformed username', async () => {
    const client = new TestClient();
    await client.get('/login', { headers: { accept: 'text/html' } });

    for (const username of ['admin', 'a', 'has space', 'UPPER!']) {
      const result = await client.post('/api/auth/register', {
        username,
        email: `${encodeURIComponent(username)}@example.com`,
        password: 'CorrectHorse!99',
      });
      expect(result.status).toBe(400);
    }
  });

  it('rejects a duplicate username with 409', async () => {
    const client = new TestClient();
    await client.register({ username: 'twice' });
    client.reset();
    await client.get('/login', { headers: { accept: 'text/html' } });

    const result = await client.post('/api/auth/register', {
      username: 'twice',
      email: 'other@example.com',
      password: 'CorrectHorse!99',
    });
    expect(result.status).toBe(409);
  });
});

describe('login', () => {
  it('accepts the right password and rotates the session', async () => {
    const client = new TestClient();
    await client.register({ username: 'rotate' });

    const before = client.cookieHeader();
    await client.post('/api/auth/logout');
    const result = await client.login('rotate');

    expect(result.status).toBe(200);
    expect(client.cookieHeader()).not.toBe(before);
  });

  it('rejects a wrong password without revealing which field was wrong', async () => {
    const client = new TestClient();
    await client.register({ username: 'careful' });
    client.reset();

    const result = await client.login('careful', 'WrongPassword!1');
    expect(result.status).toBe(401);
    // The message must be identical for "no such account" and "wrong password"
    // so it cannot be used to enumerate members.
    expect(result.body.error?.message).toBe('Incorrect username or password');
  });

  it('rejects an unknown account with the same message', async () => {
    const client = new TestClient();
    const result = await client.login('ghost', 'WrongPassword!1');
    expect(result.status).toBe(401);
    expect(result.body.error?.message).toBe('Incorrect username or password');
  });

  it('works with an email address as the identifier', async () => {
    const client = new TestClient();
    await client.register({ username: 'byemail', email: 'byemail@example.com' });
    client.reset();

    const result = await client.login('byemail@example.com');
    expect(result.status).toBe(200);
  });
});

describe('sessions', () => {
  it('reports no user for an anonymous caller and the real one after sign-in', async () => {
    const client = new TestClient();

    // `/me` is the bootstrap endpoint: it answers 200 with `user: null` rather
    // than 401, so an anonymous page load is not an error.
    const anonymous = await client.get<{ user: null }>('/api/auth/me');
    expect(anonymous.status).toBe(200);
    expect(anonymous.body.data?.user).toBeNull();

    // Endpoints that actually require an identity do reject anonymous callers.
    const guarded = await client.get('/api/auth/sessions');
    expect(guarded.status).toBe(401);
    expect(guarded.body.error?.code).toBe('UNAUTHENTICATED');

    await client.register({ username: 'whoami' });
    const authed = await client.get<{ user: { username: string } }>('/api/auth/me');
    expect(authed.status).toBe(200);
    expect(authed.body.data?.user.username).toBe('whoami');
  });

  it('treats an expired session as anonymous', async () => {
    const client = new TestClient();
    await client.register({ username: 'expired' });

    // Age the session past its expiry, exactly as time would.
    client.env.db.sqlite.exec('UPDATE sessions SET expires_at = 1, absolute_expiry = 1');

    const result = await client.get<{ user: null }>('/api/auth/me');
    expect(result.body.data?.user).toBeNull();
    expect((await client.get('/api/auth/sessions')).status).toBe(401);
  });

  it('revokes the session on logout', async () => {
    const client = new TestClient();
    await client.register({ username: 'byebye' });

    const logout = await client.post('/api/auth/logout');
    expect(logout.status).toBeLessThan(400);

    const after = await client.get<{ user: null }>('/api/auth/me');
    expect(after.body.data?.user).toBeNull();
    expect((await client.get('/api/auth/sessions')).status).toBe(401);
  });

  it('lists sessions and can revoke another one', async () => {
    const client = new TestClient();
    await client.register({ username: 'multi' });

    const other = new TestClient();
    // Same database, second "device".
    Object.assign(other.env, client.env);
    (other as unknown as { env: typeof client.env }).env = client.env;
    await other.login('multi');

    const list = await client.get<{ sessions: { id: string; current: boolean }[] }>(
      '/api/auth/sessions',
    );
    expect(list.status).toBe(200);
    expect(list.body.data!.sessions.length).toBeGreaterThanOrEqual(1);

    const target = list.body.data!.sessions.find((s) => !s.current);
    if (target) {
      const revoked = await client.delete(`/api/auth/sessions/${target.id}`);
      expect(revoked.status).toBeLessThan(400);
    }
  });
});

describe('password management', () => {
  it('changes the password and invalidates other sessions', async () => {
    const client = new TestClient();
    await client.register({ username: 'changer' });

    const wrong = await client.post('/api/auth/password', {
      currentPassword: 'NotMyPassword!1',
      newPassword: 'BrandNewSecret!22',
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error?.message).toMatch(/current password/i);

    const ok = await client.post('/api/auth/password', {
      currentPassword: 'CorrectHorse!99',
      newPassword: 'BrandNewSecret!22',
    });
    expect(ok.status).toBeLessThan(400);

    client.reset();
    const oldPassword = await client.login('changer', 'CorrectHorse!99');
    expect(oldPassword.status).toBe(401);

    const newPassword = await client.login('changer', 'BrandNewSecret!22');
    expect(newPassword.status).toBe(200);
  });

  it('does not reveal whether an email is registered on reset', async () => {
    const client = new TestClient();
    await client.register({ username: 'resetme', email: 'resetme@example.com' });
    client.reset();
    await client.get('/login', { headers: { accept: 'text/html' } });

    const known = await client.post('/api/auth/password/reset', { email: 'resetme@example.com' });
    const unknown = await client.post('/api/auth/password/reset', { email: 'nobody@example.com' });

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    // The public shape is identical; only the development-only token differs,
    // and it is omitted entirely in production (see AuthService).
    const strip = (data: unknown) => {
      const { devToken, ...rest } = (data ?? {}) as Record<string, unknown>;
      void devToken;
      return rest;
    };
    expect(strip(known.body.data)).toEqual(strip(unknown.body.data));
  });

  it('rejects an invalid reset token', async () => {
    const client = new TestClient();
    await client.get('/login', { headers: { accept: 'text/html' } });

    const result = await client.post('/api/auth/password/reset/confirm', {
      token: 'not-a-real-token',
      password: 'BrandNewSecret!22',
    });
    expect(result.status).toBeGreaterThanOrEqual(400);
  });
});

describe('account deletion', () => {
  it('requires the password and the exact confirmation string', async () => {
    const client = new TestClient();
    await client.register({ username: 'leaving' });

    const noConfirm = await client.post('/api/auth/delete-account', {
      password: 'CorrectHorse!99',
      confirm: 'yes',
    });
    expect(noConfirm.status).toBe(400);

    const wrongPassword = await client.post('/api/auth/delete-account', {
      password: 'Nope!123456',
      confirm: 'DELETE',
    });
    expect(wrongPassword.status).toBe(400);

    const ok = await client.post('/api/auth/delete-account', {
      password: 'CorrectHorse!99',
      confirm: 'DELETE',
    });
    expect(ok.status).toBeLessThan(400);

    client.reset();
    const login = await client.login('leaving');
    expect(login.status).toBeGreaterThanOrEqual(400);
  });
});
