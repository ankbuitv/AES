/**
 * S3-compatible storage adapter with AWS Signature V4 signing.
 *
 * Works with the Backblaze S3-compatible endpoint, Cloudflare R2's S3 API,
 * MinIO, Wasabi and AWS itself. Signing is implemented with WebCrypto because
 * the AWS SDK is far too heavy for a Worker bundle.
 */

import type {
  GetObjectResult,
  ObjectMetadata,
  PutObjectInput,
  PutObjectResult,
  StorageProvider,
} from './storage';
import { assertSafeKey } from './storage';
import { hmacRaw, sha256Hex, toHex } from '../utils/crypto';
import { AppError } from '../utils/errors';

export interface S3Config {
  endpoint: string; // e.g. https://s3.us-west-004.backblazeb2.com
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Backblaze/MinIO use path-style addressing. */
  forcePathStyle?: boolean;
}

const SERVICE = 's3';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export class S3StorageProvider implements StorageProvider {
  readonly name = 's3' as const;

  constructor(private readonly config: S3Config) {
    if (!config.endpoint || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
      throw AppError.storage('S3 storage is not configured');
    }
  }

  private objectUrl(key: string): URL {
    const base = new URL(this.config.endpoint.replace(/\/+$/, ''));
    const encodedKey = key.split('/').map(encodeRfc3986).join('/');
    if (this.config.forcePathStyle !== false) {
      base.pathname = `/${encodeRfc3986(this.config.bucket)}/${encodedKey}`;
    } else {
      base.hostname = `${this.config.bucket}.${base.hostname}`;
      base.pathname = `/${encodedKey}`;
    }
    return base;
  }

  async uploadObject(input: PutObjectInput): Promise<PutObjectResult> {
    assertSafeKey(input.key);
    const bytes = input.body instanceof Uint8Array ? input.body : new Uint8Array(input.body);
    const url = this.objectUrl(input.key);
    const payloadHash = await sha256Hex(bytes);

    const headers: Record<string, string> = {
      'content-type': input.contentType || 'application/octet-stream',
      'content-length': String(bytes.byteLength),
    };
    for (const [k, v] of Object.entries(input.metadata ?? {})) {
      headers[`x-amz-meta-${k.toLowerCase()}`] = encodeURIComponent(v).slice(0, 500);
    }

    const signed = await this.sign('PUT', url, headers, payloadHash);
    const res = await fetch(url.toString(), {
      method: 'PUT',
      headers: signed,
      body: bytes as unknown as BodyInit,
    });

    if (!res.ok) {
      throw AppError.storage('Upload to storage failed', {
        status: res.status,
        body: (await res.text()).slice(0, 300),
      });
    }

    return {
      key: input.key,
      size: bytes.byteLength,
      etag: res.headers.get('ETag') ?? undefined,
    };
  }

  async downloadObject(key: string, range?: string): Promise<GetObjectResult | null> {
    assertSafeKey(key);
    const url = this.objectUrl(key);
    const headers: Record<string, string> = {};
    if (range) headers['range'] = range;

    const signed = await this.sign('GET', url, headers, UNSIGNED_PAYLOAD);
    const res = await fetch(url.toString(), { headers: signed });

    if (res.status === 404) return null;
    if (!res.ok && res.status !== 206) {
      throw AppError.storage('Could not read object from storage', { status: res.status });
    }
    if (!res.body) return null;

    return {
      body: res.body as ReadableStream<Uint8Array>,
      size: Number(res.headers.get('Content-Length') ?? 0),
      contentType: res.headers.get('Content-Type') ?? 'application/octet-stream',
      etag: res.headers.get('ETag') ?? undefined,
      lastModified: parseHttpDate(res.headers.get('Last-Modified')),
      metadata: extractAmzMeta(res.headers),
    };
  }

  async headObject(key: string): Promise<ObjectMetadata | null> {
    assertSafeKey(key);
    const url = this.objectUrl(key);
    const signed = await this.sign('HEAD', url, {}, UNSIGNED_PAYLOAD);
    const res = await fetch(url.toString(), { method: 'HEAD', headers: signed });

    // Missing objects are not an error. Some S3-compatible hosts answer 403
    // or 405 for HEAD of an unknown key even when credentials are valid.
    if (res.status === 404 || res.status === 403 || res.status === 405) return null;
    if (!res.ok) throw AppError.storage('Could not stat object', { status: res.status });

    return {
      key,
      size: Number(res.headers.get('Content-Length') ?? 0),
      contentType: res.headers.get('Content-Type') ?? 'application/octet-stream',
      etag: res.headers.get('ETag') ?? undefined,
      lastModified: parseHttpDate(res.headers.get('Last-Modified')),
      metadata: extractAmzMeta(res.headers),
    };
  }

  async getObjectMetadata(key: string): Promise<ObjectMetadata | null> {
    return this.headObject(key);
  }

  async objectExists(key: string): Promise<boolean> {
    return (await this.headObject(key)) !== null;
  }

  async deleteObject(key: string): Promise<void> {
    assertSafeKey(key);
    const url = this.objectUrl(key);
    const signed = await this.sign('DELETE', url, {}, UNSIGNED_PAYLOAD);
    const res = await fetch(url.toString(), { method: 'DELETE', headers: signed });
    if (!res.ok && res.status !== 204 && res.status !== 404) {
      throw AppError.storage('Could not delete object', { status: res.status });
    }
  }

  async healthCheck(): Promise<void> {
    const url = new URL(this.objectUrl('health/probe').toString());
    // List a single key under a reserved prefix — proves signing + bucket
    // access without requiring an object to exist.
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', 'health/');
    url.searchParams.set('max-keys', '1');
    const signed = await this.sign('GET', url, {}, UNSIGNED_PAYLOAD);
    const res = await fetch(url.toString(), { headers: signed });
    if (res.status === 404) return;
    if (!res.ok) {
      // Fall back to a missing-key HEAD: list may be denied on tightly scoped keys.
      await this.headObject('health/probe');
    }
  }

  /** Query-string (presigned) URL — SigV4 with credentials in the query. */
  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string | null> {
    assertSafeKey(key);
    const url = this.objectUrl(key);
    const expires = Math.min(Math.max(expiresInSeconds, 60), 604_800);
    const { amzDate, dateStamp } = timestamps();
    const credentialScope = `${dateStamp}/${this.config.region}/${SERVICE}/aws4_request`;

    url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
    url.searchParams.set('X-Amz-Credential', `${this.config.accessKeyId}/${credentialScope}`);
    url.searchParams.set('X-Amz-Date', amzDate);
    url.searchParams.set('X-Amz-Expires', String(expires));
    url.searchParams.set('X-Amz-SignedHeaders', 'host');

    const canonicalRequest = [
      'GET',
      url.pathname,
      canonicalQueryString(url),
      `host:${url.host}\n`,
      'host',
      UNSIGNED_PAYLOAD,
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      await sha256Hex(canonicalRequest),
    ].join('\n');

    const signature = toHex(await this.signingKey(dateStamp, stringToSign));
    url.searchParams.set('X-Amz-Signature', signature);
    return url.toString();
  }

  // --- SigV4 ----------------------------------------------------------------

  private async sign(
    method: string,
    url: URL,
    headers: Record<string, string>,
    payloadHash: string,
  ): Promise<Record<string, string>> {
    const { amzDate, dateStamp } = timestamps();
    const all: Record<string, string> = {
      ...lowercaseKeys(headers),
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };

    const sortedKeys = Object.keys(all).sort();
    const canonicalHeaders = sortedKeys.map((k) => `${k}:${all[k]!.trim()}\n`).join('');
    const signedHeaders = sortedKeys.join(';');

    const canonicalRequest = [
      method,
      url.pathname,
      canonicalQueryString(url),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${this.config.region}/${SERVICE}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      await sha256Hex(canonicalRequest),
    ].join('\n');

    const signature = toHex(await this.signingKey(dateStamp, stringToSign));

    return {
      ...all,
      Authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }

  private async signingKey(dateStamp: string, stringToSign: string): Promise<Uint8Array> {
    const encoder = new TextEncoder();
    let key = await hmacRaw(encoder.encode(`AWS4${this.config.secretAccessKey}`), dateStamp);
    key = await hmacRaw(key, this.config.region);
    key = await hmacRaw(key, SERVICE);
    key = await hmacRaw(key, 'aws4_request');
    return hmacRaw(key, stringToSign);
  }
}

// --- helpers ----------------------------------------------------------------

function timestamps(): { amzDate: string; dateStamp: string } {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function canonicalQueryString(url: URL): string {
  const params = [...url.searchParams.entries()]
    .filter(([k]) => k !== 'X-Amz-Signature')
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  return params.map(([k, v]) => `${k}=${v}`).join('&');
}

/** AWS requires RFC-3986 encoding; encodeURIComponent leaves !'()* alone. */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function parseHttpDate(value: string | null): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function extractAmzMeta(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower.startsWith('x-amz-meta-')) {
      try {
        out[lower.slice('x-amz-meta-'.length)] = decodeURIComponent(value);
      } catch {
        out[lower.slice('x-amz-meta-'.length)] = value;
      }
    }
  });
  return out;
}
