/**
 * B2 adapter health probe.
 *
 * The probe must prove credentials + bucket reachability without requiring a
 * known object, and — critically — must not require capabilities the app's own
 * key may not have (`listFiles`). The download-URL HEAD only needs `readFiles`,
 * which every media read already uses, and B2 answers 404/400/405 for a
 * missing name, meaning "reachable and authorized".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { B2StorageProvider } from '../src/services/b2';

const CONFIG = {
  applicationKeyId: 'key-id',
  applicationKey: 'key-secret',
  bucketId: 'bucket-id',
  bucketName: 'bucket-name',
};

const AUTHORIZE_BODY = {
  authorizationToken: 'token-1',
  accountId: 'acct',
  apiInfo: {
    storageApi: { apiUrl: 'https://pod.example', downloadUrl: 'https://dl.example' },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('B2StorageProvider healthCheck', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('treats a 404 probe key as a healthy bucket and never needs b2_list_file_names', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('b2_authorize_account')) return jsonResponse(AUTHORIZE_BODY);
        if (url.startsWith('https://dl.example/')) return new Response(null, { status: 404 });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const provider = new B2StorageProvider(CONFIG);
    await expect(provider.healthCheck()).resolves.toBeUndefined();
    expect(calls.some((url) => url.includes('b2_list_file_names'))).toBe(false);
  });

  it('fails when the download host rejects the probe with a 5xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('b2_authorize_account')) return jsonResponse(AUTHORIZE_BODY);
        if (url.startsWith('https://dl.example/')) return new Response(null, { status: 503 });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const provider = new B2StorageProvider(CONFIG);
    await expect(provider.healthCheck()).rejects.toMatchObject({ status: 502 });
  });

  it('refreshes the auth token once when the probe answers 401', async () => {
    let authorizeCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('b2_authorize_account')) {
          authorizeCalls += 1;
          return jsonResponse(AUTHORIZE_BODY);
        }
        if (url.startsWith('https://dl.example/')) {
          // First probe with the cached token is rejected; the retry (after
          // forced re-authorize) succeeds.
          return new Response(null, { status: authorizeCalls === 2 ? 404 : 401 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const provider = new B2StorageProvider(CONFIG);
    await expect(provider.healthCheck()).resolves.toBeUndefined();
    expect(authorizeCalls).toBeGreaterThanOrEqual(2);
  });
});
