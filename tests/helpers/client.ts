/**
 * HTTP-level test client.
 *
 * Drives the real Worker (`worker/index.ts`) end to end: cookies, CSRF tokens,
 * redirects and the JSON envelope all behave exactly as they do in a browser.
 * Anything these tests prove is proven about the deployed code path, not about
 * a stub.
 */

import worker from '../../worker/index';
import { createTestEnv, type TestEnv } from './env';
import type { Bindings } from '../../src/types/env';

export interface ApiEnvelope<T = unknown> {
  success: boolean;
  data: T | null;
  error: { code: string; message: string; requestId?: string; details?: unknown } | null;
}

export interface TestResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: ApiEnvelope<T>;
  text: string;
}

const ORIGIN = 'http://localhost:8787';

type ClientInit = Omit<RequestInit, 'body'> & {
  json?: unknown;
  form?: Record<string, string>;
  body?: BodyInit;
};

export class TestClient {
  readonly env: TestEnv;
  private cookies = new Map<string, string>();
  private csrf: string | null = null;

  constructor(overrides: Partial<Bindings> = {}, options: { empty?: boolean } = {}) {
    this.env = createTestEnv(overrides, options);
  }

  get bindings(): Bindings {
    return this.env.bindings;
  }

  cookieHeader(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /** Clear the session, as a browser "sign out everywhere" would. */
  reset(): void {
    this.cookies.clear();
    this.csrf = null;
  }

  private captureCookies(response: Response): void {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const cookie of raw) {
      const [pair] = cookie.split(';');
      const index = pair?.indexOf('=') ?? -1;
      if (index < 0 || !pair) continue;
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
      if (name === 'ank_csrf') this.csrf = value === '' ? null : value;
    }
  }

  async raw(path: string, init: ClientInit = {}): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    // Only default the Origin; a test that supplies one is exercising the
    // cross-origin rejection path.
    if (!headers.has('origin')) headers.set('origin', ORIGIN);
    headers.set('host', 'localhost:8787');
    if (!headers.has('accept')) headers.set('accept', 'application/json');

    const cookie = this.cookieHeader();
    if (cookie) headers.set('cookie', cookie);
    if (this.csrf && method !== 'GET' && method !== 'HEAD') {
      headers.set('x-csrf-token', this.csrf);
    }

    let body: BodyInit | undefined = init.body;
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    } else if (init.form) {
      const form = new URLSearchParams(init.form);
      headers.set('content-type', 'application/x-www-form-urlencoded');
      body = form.toString();
    }

    const request = new Request(`${ORIGIN}${path}`, { method, headers, body });
    const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => undefined), passThroughOnException() {} };
    const response = await worker.fetch(request, this.bindings, ctx as ExecutionContext);
    this.captureCookies(response);
    return response;
  }

  async request<T = unknown>(path: string, init: ClientInit = {}): Promise<TestResponse<T>> {
    const response = await this.raw(path, init);
    const text = await response.text();
    let body: ApiEnvelope<T>;
    try {
      body = JSON.parse(text) as ApiEnvelope<T>;
    } catch {
      body = { success: response.ok, data: null, error: null };
    }
    return { status: response.status, headers: response.headers, body, text };
  }

  get<T = unknown>(path: string, init: ClientInit = {}) {
    return this.request<T>(path, { ...init, method: 'GET' });
  }

  post<T = unknown>(path: string, form?: Record<string, string>, init: ClientInit = {}) {
    return this.request<T>(path, { ...init, method: 'POST', ...(form ? { form } : {}) });
  }

  patch<T = unknown>(path: string, form?: Record<string, string>, init: ClientInit = {}) {
    return this.request<T>(path, { ...init, method: 'PATCH', ...(form ? { form } : {}) });
  }

  delete<T = unknown>(path: string, init: ClientInit = {}) {
    return this.request<T>(path, { ...init, method: 'DELETE' });
  }

  /** Multipart upload helper (media tests). */
  async upload<T = unknown>(
    path: string,
    file: { name: string; type: string; bytes: Uint8Array },
    fields: Record<string, string> = {},
  ): Promise<TestResponse<T>> {
    const form = new FormData();
    form.set('file', new File([file.bytes as unknown as ArrayBufferView], file.name, { type: file.type }));
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    return this.request<T>(path, { method: 'POST', body: form });
  }

  /**
   * Fetch a page first so an anonymous CSRF token exists, then register and
   * return the created account. Mirrors what a browser does.
   */
  async register(input: {
    username: string;
    email?: string;
    password?: string;
    displayName?: string;
  }): Promise<{ id: string; username: string; role: string }> {
    await this.get('/login', { headers: { accept: 'text/html' } });
    const response = await this.post<{ user: { id: string; username: string; role: string } }>(
      '/api/auth/register',
      {
        username: input.username,
        email: input.email ?? `${input.username}@example.com`,
        password: input.password ?? 'CorrectHorse!99',
        displayName: input.displayName ?? input.username,
      },
    );
    if (!response.body.success) {
      throw new Error(`register failed: ${response.body.error?.message ?? response.status}`);
    }
    return response.body.data!.user;
  }

  async login(username: string, password = 'CorrectHorse!99'): Promise<TestResponse> {
    await this.get('/login', { headers: { accept: 'text/html' } });
    return this.post('/api/auth/login', { identifier: username, password });
  }

  /** Promote an account directly in SQL — used to set up moderator tests. */
  promote(username: string, role: 'moderator' | 'admin'): void {
    this.env.db.sqlite
      .prepare('UPDATE users SET role = ? WHERE username = ?')
      .run(role, username.toLowerCase());
  }
}

export async function createClient(overrides: Partial<Bindings> = {}): Promise<TestClient> {
  return new TestClient(overrides);
}
