/**
 * Backblaze B2 storage adapter (native B2 API).
 *
 * Implements the full lifecycle the app needs: authorize → get upload URL →
 * upload → download → head → delete, plus a KV-backed cache for the
 * authorization token and upload URLs (both are expensive to obtain and B2
 * rate-limits `b2_authorize_account`).
 *
 * Credentials never leave the Worker. The browser only ever talks to
 * `/api/media/upload` and `/media/{id}` on our own origin.
 *
 * B2 specifics handled here:
 *  - `b2_authorize_account` returns an apiUrl/downloadUrl per account; both are
 *    cached with the token (valid 24h, we refresh at 20h).
 *  - Every upload needs a fresh-ish `b2_get_upload_url`; a URL can be reused
 *    until B2 answers 503/401, at which point we re-fetch and retry once.
 *  - Uploads must carry `X-Bz-Content-Sha1`.
 *  - Deletion needs the fileId, so we resolve it via `b2_list_file_names`.
 */

import type {
  GetObjectResult,
  ObjectMetadata,
  PutObjectInput,
  PutObjectResult,
  StorageProvider,
} from './storage';
import { assertSafeKey } from './storage';
import { basicAuth, sha1Hex } from '../utils/crypto';
import { AppError } from '../utils/errors';

interface B2AuthState {
  authorizationToken: string;
  apiUrl: string;
  downloadUrl: string;
  accountId: string;
  expiresAt: number;
}

interface B2UploadUrl {
  uploadUrl: string;
  authorizationToken: string;
  expiresAt: number;
}

export interface B2Config {
  applicationKeyId: string;
  applicationKey: string;
  bucketId: string;
  bucketName: string;
  apiUrl?: string;
}

const AUTH_CACHE_KEY = 'b2:auth:v1';
const UPLOAD_URL_CACHE_KEY = 'b2:upload-url:v1';
const AUTH_TTL_SECONDS = 20 * 60 * 60; // B2 tokens last 24h; refresh early.
const UPLOAD_URL_TTL_SECONDS = 60 * 60;

export class B2StorageProvider implements StorageProvider {
  readonly name = 'b2' as const;

  constructor(
    private readonly config: B2Config,
    private readonly kv?: KVNamespace,
  ) {
    if (!config.applicationKeyId || !config.applicationKey) {
      throw AppError.storage('B2 credentials are not configured');
    }
    if (!config.bucketId || !config.bucketName) {
      throw AppError.storage('B2 bucket is not configured');
    }
  }

  // --- Authorization --------------------------------------------------------

  private memoAuth: B2AuthState | null = null;

  private async authorize(force = false): Promise<B2AuthState> {
    const nowMs = Date.now();

    if (!force && this.memoAuth && this.memoAuth.expiresAt > nowMs) return this.memoAuth;

    if (!force && this.kv) {
      const cached = await this.kv.get<B2AuthState>(AUTH_CACHE_KEY, 'json');
      if (cached && cached.expiresAt > nowMs) {
        this.memoAuth = cached;
        return cached;
      }
    }

    const endpoint = `${this.config.apiUrl ?? 'https://api.backblazeb2.com'}/b2api/v3/b2_authorize_account`;
    const res = await fetch(endpoint, {
      headers: { Authorization: basicAuth(this.config.applicationKeyId, this.config.applicationKey) },
    });

    if (!res.ok) {
      throw AppError.storage('Storage authorization failed', {
        status: res.status,
        body: await safeText(res),
      });
    }

    const data = (await res.json()) as {
      authorizationToken: string;
      accountId: string;
      apiInfo?: { storageApi?: { apiUrl?: string; downloadUrl?: string } };
      apiUrl?: string;
      downloadUrl?: string;
    };

    const apiUrl = data.apiInfo?.storageApi?.apiUrl ?? data.apiUrl;
    const downloadUrl = data.apiInfo?.storageApi?.downloadUrl ?? data.downloadUrl;

    if (!apiUrl || !downloadUrl) {
      throw AppError.storage('Storage authorization returned an unexpected payload');
    }

    const state: B2AuthState = {
      authorizationToken: data.authorizationToken,
      apiUrl: apiUrl.replace(/\/+$/, ''),
      downloadUrl: downloadUrl.replace(/\/+$/, ''),
      accountId: data.accountId,
      expiresAt: nowMs + AUTH_TTL_SECONDS * 1000,
    };

    this.memoAuth = state;
    if (this.kv) {
      await this.kv.put(AUTH_CACHE_KEY, JSON.stringify(state), {
        expirationTtl: AUTH_TTL_SECONDS,
      });
    }
    return state;
  }

  /** Run an authorized call, refreshing the token once on 401. */
  private async withAuth<T>(fn: (auth: B2AuthState) => Promise<T | typeof RETRY>): Promise<T> {
    const first = await fn(await this.authorize());
    if (first !== RETRY) return first;
    const second = await fn(await this.authorize(true));
    if (second === RETRY) throw AppError.storage('Storage authorization kept failing');
    return second;
  }

  // --- Upload ---------------------------------------------------------------

  private async getUploadUrl(force = false): Promise<B2UploadUrl> {
    const nowMs = Date.now();

    if (!force && this.kv) {
      const cached = await this.kv.get<B2UploadUrl>(UPLOAD_URL_CACHE_KEY, 'json');
      if (cached && cached.expiresAt > nowMs) return cached;
    }

    const fresh = await this.withAuth(async (auth) => {
      const res = await fetch(`${auth.apiUrl}/b2api/v3/b2_get_upload_url`, {
        method: 'POST',
        headers: {
          Authorization: auth.authorizationToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ bucketId: this.config.bucketId }),
      });
      if (res.status === 401) return RETRY;
      if (!res.ok) {
        throw AppError.storage('Could not obtain an upload URL', {
          status: res.status,
          body: await safeText(res),
        });
      }
      const data = (await res.json()) as { uploadUrl: string; authorizationToken: string };
      return {
        uploadUrl: data.uploadUrl,
        authorizationToken: data.authorizationToken,
        expiresAt: nowMs + UPLOAD_URL_TTL_SECONDS * 1000,
      } satisfies B2UploadUrl;
    });

    if (this.kv) {
      await this.kv.put(UPLOAD_URL_CACHE_KEY, JSON.stringify(fresh), {
        expirationTtl: UPLOAD_URL_TTL_SECONDS,
      });
    }
    return fresh;
  }

  async uploadObject(input: PutObjectInput): Promise<PutObjectResult> {
    assertSafeKey(input.key);
    const bytes = input.body instanceof Uint8Array ? input.body : new Uint8Array(input.body);
    const sha1 = input.sha1 ?? (await sha1Hex(bytes));

    const attempt = async (uploadUrl: B2UploadUrl): Promise<Response> => {
      const headers: Record<string, string> = {
        Authorization: uploadUrl.authorizationToken,
        'X-Bz-File-Name': encodeB2FileName(input.key),
        'Content-Type': input.contentType || 'application/octet-stream',
        'Content-Length': String(bytes.byteLength),
        'X-Bz-Content-Sha1': sha1,
      };
      for (const [k, v] of Object.entries(input.metadata ?? {})) {
        // B2 caps custom metadata at 10 entries / 2 KB total.
        headers[`X-Bz-Info-${encodeURIComponent(k)}`] = encodeURIComponent(v).slice(0, 500);
      }
      return fetch(uploadUrl.uploadUrl, {
        method: 'POST',
        headers,
        body: bytes as unknown as BodyInit,
      });
    };

    let res = await attempt(await this.getUploadUrl());
    // B2 tells us to re-request the upload URL on 401/503/408.
    if (res.status === 401 || res.status === 503 || res.status === 408) {
      res = await attempt(await this.getUploadUrl(true));
    }

    if (!res.ok) {
      throw AppError.storage('Upload to storage failed', {
        status: res.status,
        body: await safeText(res),
      });
    }

    const data = (await res.json()) as { fileId: string; contentLength: number };
    return {
      key: input.key,
      size: data.contentLength ?? bytes.byteLength,
      versionId: data.fileId,
    };
  }

  // --- Download -------------------------------------------------------------

  async downloadObject(key: string, range?: string): Promise<GetObjectResult | null> {
    assertSafeKey(key);
    return this.withAuth(async (auth) => {
      const url = `${auth.downloadUrl}/file/${encodeURIComponent(this.config.bucketName)}/${encodeKeyPath(key)}`;
      const headers: Record<string, string> = { Authorization: auth.authorizationToken };
      if (range) headers['Range'] = range;

      const res = await fetch(url, { headers });
      if (res.status === 401) return RETRY;
      if (res.status === 404) return null;
      if (!res.ok && res.status !== 206) {
        throw AppError.storage('Could not read object from storage', {
          status: res.status,
        });
      }
      if (!res.body) return null;

      return {
        body: res.body as ReadableStream<Uint8Array>,
        size: Number(res.headers.get('Content-Length') ?? 0),
        contentType: res.headers.get('Content-Type') ?? 'application/octet-stream',
        etag: res.headers.get('ETag') ?? undefined,
        lastModified: parseB2Timestamp(res.headers.get('X-Bz-Upload-Timestamp')),
        metadata: extractB2Info(res.headers),
      } satisfies GetObjectResult;
    });
  }

  // --- Metadata -------------------------------------------------------------

  async headObject(key: string): Promise<ObjectMetadata | null> {
    assertSafeKey(key);
    return this.withAuth(async (auth) => {
      const url = `${auth.downloadUrl}/file/${encodeURIComponent(this.config.bucketName)}/${encodeKeyPath(key)}`;
      const res = await fetch(url, {
        method: 'HEAD',
        headers: { Authorization: auth.authorizationToken },
      });
      if (res.status === 401) return RETRY;
      if (res.status === 404) return null;
      if (!res.ok) {
        throw AppError.storage('Could not stat object', { status: res.status });
      }
      return {
        key,
        size: Number(res.headers.get('Content-Length') ?? 0),
        contentType: res.headers.get('Content-Type') ?? 'application/octet-stream',
        etag: res.headers.get('ETag') ?? undefined,
        lastModified: parseB2Timestamp(res.headers.get('X-Bz-Upload-Timestamp')),
        metadata: extractB2Info(res.headers),
      } satisfies ObjectMetadata;
    });
  }

  async getObjectMetadata(key: string): Promise<ObjectMetadata | null> {
    return this.headObject(key);
  }

  async objectExists(key: string): Promise<boolean> {
    return (await this.headObject(key)) !== null;
  }

  // --- Delete ---------------------------------------------------------------

  /** B2 deletes by (fileName, fileId), so resolve every version first. */
  private async listFileVersions(key: string): Promise<{ fileId: string; fileName: string }[]> {
    return this.withAuth(async (auth) => {
      const res = await fetch(`${auth.apiUrl}/b2api/v3/b2_list_file_versions`, {
        method: 'POST',
        headers: {
          Authorization: auth.authorizationToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bucketId: this.config.bucketId,
          startFileName: key,
          prefix: key,
          maxFileCount: 100,
        }),
      });
      if (res.status === 401) return RETRY;
      if (!res.ok) {
        throw AppError.storage('Could not list object versions', { status: res.status });
      }
      const data = (await res.json()) as { files: { fileId: string; fileName: string }[] };
      return (data.files ?? []).filter((f) => f.fileName === key);
    });
  }

  async deleteObject(key: string): Promise<void> {
    assertSafeKey(key);
    const versions = await this.listFileVersions(key);
    if (!versions.length) return; // already gone — deletion is idempotent

    for (const version of versions) {
      await this.withAuth(async (auth) => {
        const res = await fetch(`${auth.apiUrl}/b2api/v3/b2_delete_file_version`, {
          method: 'POST',
          headers: {
            Authorization: auth.authorizationToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ fileName: version.fileName, fileId: version.fileId }),
        });
        if (res.status === 401) return RETRY;
        // 400 with file_not_present means someone else deleted it — fine.
        if (!res.ok && res.status !== 400) {
          throw AppError.storage('Could not delete object', { status: res.status });
        }
        return true;
      });
    }
  }

  // --- Signed URLs ----------------------------------------------------------

  /**
   * B2 download authorization token, scoped to a single key prefix.
   * Only usable for buckets that are private; the Worker still prefers to proxy
   * so that permission checks cannot be bypassed by sharing the URL.
   */
  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string | null> {
    assertSafeKey(key);
    const seconds = Math.min(Math.max(expiresInSeconds, 60), 604_800);
    return this.withAuth(async (auth) => {
      const res = await fetch(`${auth.apiUrl}/b2api/v3/b2_get_download_authorization`, {
        method: 'POST',
        headers: {
          Authorization: auth.authorizationToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bucketId: this.config.bucketId,
          fileNamePrefix: key,
          validDurationInSeconds: seconds,
        }),
      });
      if (res.status === 401) return RETRY;
      if (!res.ok) return null;
      const data = (await res.json()) as { authorizationToken: string };
      const base = `${auth.downloadUrl}/file/${encodeURIComponent(this.config.bucketName)}/${encodeKeyPath(key)}`;
      return `${base}?Authorization=${encodeURIComponent(data.authorizationToken)}`;
    });
  }
}

// --- helpers ----------------------------------------------------------------

const RETRY = Symbol('retry') as unknown as never;

/** B2 requires the file name percent-encoded, but '/' stays literal. */
function encodeB2FileName(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function encodeKeyPath(key: string): string {
  return encodeB2FileName(key);
}

function parseB2Timestamp(value: string | null): number | undefined {
  if (!value) return undefined;
  const ms = Number(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function extractB2Info(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower.startsWith('x-bz-info-')) {
      try {
        out[decodeURIComponent(lower.slice('x-bz-info-'.length))] = decodeURIComponent(value);
      } catch {
        out[lower.slice('x-bz-info-'.length)] = value;
      }
    }
  });
  return out;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}
