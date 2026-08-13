/**
 * Cross-cutting security guarantees: CSRF, origin validation, security
 * headers, rate limiting, body limits, XSS escaping and error shape.
 */

import { describe, expect, it } from 'vitest';
import { TestClient } from './helpers/client';
import worker from '../worker/index';
import { createTestEnv } from './helpers/env';

function ctx() {
  return { waitUntil: (p: Promise<unknown>) => void p.catch(() => undefined), passThroughOnException() {} } as unknown as ExecutionContext;
}

describe('security headers', () => {
  it('sets CSP, nosniff, referrer and permissions policies on HTML', async () => {
    const client = new TestClient();
    const response = await client.raw('/login', { headers: { accept: 'text/html' } });

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('permissions-policy')).toContain('geolocation=()');

    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toMatch(/script-src [^;]*'nonce-/);
    expect(csp).not.toContain("script-src 'unsafe-inline'");
  });

  it('marks API responses as noindex and Vary: Cookie', async () => {
    const client = new TestClient();
    const response = await client.raw('/api/posts');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.get('vary')).toContain('Cookie');
  });

  it('does not send HSTS outside production', async () => {
    const client = new TestClient();
    const response = await client.raw('/health');
    expect(response.headers.get('strict-transport-security')).toBeNull();
  });

  it('sends HSTS in production', async () => {
    const { bindings } = createTestEnv({ ENVIRONMENT: 'production' });
    const response = await worker.fetch(
      new Request('https://ankb.qzz.io/health'),
      bindings,
      ctx(),
    );
    expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000');
  });
});

describe('CSRF protection', () => {
  it('rejects a state-changing request with no token', async () => {
    const { bindings } = createTestEnv();
    const response = await worker.fetch(
      new Request('http://localhost:8787/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:8787' },
        body: JSON.stringify({
          username: 'csrfless',
          email: 'csrfless@example.com',
          password: 'CorrectHorse!99',
        }),
      }),
      bindings,
      ctx(),
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CSRF_FAILED');
  });

  it('rejects a cross-origin submission even with a stolen token', async () => {
    const client = new TestClient();
    await client.get('/login', { headers: { accept: 'text/html' } });

    const response = await client.raw('/api/auth/register', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      form: {
        username: 'crossorigin',
        email: 'x@example.com',
        password: 'CorrectHorse!99',
      },
    });

    expect(response.status).toBe(403);
  });

  it('accepts a same-origin request carrying the issued token', async () => {
    const client = new TestClient();
    const user = await client.register({ username: 'goodtoken' });
    expect(user.username).toBe('goodtoken');
  });

  it('does not require a token for safe methods', async () => {
    const client = new TestClient();
    const response = await client.get('/api/posts');
    expect(response.status).toBe(200);
  });
});

describe('rate limiting', () => {
  it('returns 429 with Retry-After once the login tier is exhausted', async () => {
    const client = new TestClient();
    await client.register({ username: 'target' });
    client.reset();
    await client.get('/login', { headers: { accept: 'text/html' } });

    let limited: Awaited<ReturnType<TestClient['post']>> | null = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await client.post('/api/auth/login', {
        identifier: 'target',
        password: 'DefinitelyWrong!1',
      });
      if (response.status === 429) {
        limited = response;
        break;
      }
    }

    expect(limited).not.toBeNull();
    expect(limited!.body.error?.code).toBe('RATE_LIMITED');
    expect(Number(limited!.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('uses a separate, more generous tier for reads', async () => {
    const client = new TestClient();
    for (let i = 0; i < 20; i++) {
      const response = await client.get('/api/posts');
      expect(response.status).toBe(200);
    }
  });
});

describe('input validation', () => {
  it('rejects an oversized JSON body before parsing it', async () => {
    const client = new TestClient();
    await client.get('/login', { headers: { accept: 'text/html' } });

    const huge = 'a'.repeat(300_000);
    const response = await client.request('/api/auth/register', {
      method: 'POST',
      json: { username: 'big', email: 'big@example.com', password: 'CorrectHorse!99', bio: huge },
      headers: { 'content-length': String(300_100) },
    });

    expect([400, 413]).toContain(response.status);
  });

  it('rejects an invalid cursor instead of trusting it', async () => {
    const client = new TestClient();
    const response = await client.get('/api/posts?cursor=' + 'x'.repeat(300));
    expect(response.status).toBe(400);
  });

  it('rejects an out-of-range limit', async () => {
    const client = new TestClient();
    expect((await client.get('/api/posts?limit=0')).status).toBe(400);
    expect((await client.get('/api/posts?limit=500')).status).toBe(400);
    expect((await client.get('/api/posts?limit=abc')).status).toBe(400);
  });
});

describe('XSS and output escaping', () => {
  it('escapes script tags in a display name rendered into HTML', async () => {
    const client = new TestClient();
    await client.register({ username: 'xssuser', displayName: '<script>alert(1)</script>' });

    const response = await client.raw('/u/xssuser', { headers: { accept: 'text/html' } });
    const html = await response.text();

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('strips raw HTML from post content', async () => {
    const client = new TestClient();
    await client.register({ username: 'markdowner' });

    const created = await client.post<{ post: { html: string; slug: string } }>('/api/posts', {
      content: 'Hello <img src=x onerror=alert(1)> <script>alert(2)</script> **bold**',
      contentType: 'markdown',
    });

    expect(created.status).toBe(201);
    const html = created.body.data!.post.html;

    // The renderer escapes first and only then whitelists its own markup, so
    // user angle brackets can never become live tags or attributes.
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('refuses a javascript: URL in a link post', async () => {
    const client = new TestClient();
    await client.register({ username: 'linker' });

    const created = await client.post('/api/posts', {
      content: 'sketchy',
      contentType: 'link',
      linkUrl: 'javascript:alert(1)',
    });

    expect(created.status).toBe(400);
  });
});

describe('error envelope', () => {
  it('returns {success,data,error} with a code and no stack trace', async () => {
    const client = new TestClient();
    const response = await client.get('/api/posts/pst_doesnotexist000');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ success: false, data: null });
    expect(response.body.error?.code).toBe('NOT_FOUND');
    expect(response.body.error?.requestId).toBeTruthy();
    expect(response.text).not.toMatch(/at .+\(.+:\d+:\d+\)/);
    expect(response.text).not.toContain('Database error');
    expect(response.text).not.toMatch(/SELECT /i);
  });

  it('renders an HTML error page for browser navigation', async () => {
    const client = new TestClient();
    const response = await client.raw('/definitely-not-a-page', {
      headers: { accept: 'text/html' },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('404');
  });
});

describe('health endpoint', () => {
  it('answers with status ok', async () => {
    const client = new TestClient();
    const response = await client.raw('/health');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe('ok');
    expect(body.checks.database).toBe('ok');
  });

  it('does not 500 when SESSION_SECRET is not configured', async () => {
    // Regression: an empty/missing SESSION_SECRET used to throw a WebCrypto
    // DataError (zero-length HMAC key) inside issueCsrfToken in the session
    // middleware, turning every request — including /health — into a 500.
    // It must degrade gracefully to a 200 health probe.
    const { bindings } = createTestEnv({
      SESSION_SECRET: '',
      IP_HASH_SALT: '',
    });
    const response = await worker.fetch(
      new Request('http://localhost:8787/health'),
      bindings,
      ctx(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe('ok');
  });
});
