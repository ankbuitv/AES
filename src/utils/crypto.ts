/**
 * Cryptography helpers built on WebCrypto (the only primitive available in
 * Workers — there is no argon2/bcrypt native module in the runtime).
 *
 * Password hashing uses PBKDF2-HMAC-SHA-256 with a per-password random salt.
 * Cloudflare Workers limits PBKDF2 derivations to 100,000 iterations on the
 * compatibility/runtime configurations used by this app. Going above that
 * limit throws from `crypto.subtle.deriveBits()` and turns sign-up into an
 * opaque Worker 500, so use the strongest portable value instead. The encoded
 * format carries its own parameters, allowing a future compatible runtime to
 * raise the work factor and transparently re-hash passwords on login.
 */

import { base64UrlDecode, base64UrlEncode } from './id';

/** Highest PBKDF2-HMAC-SHA-256 work factor portable across Cloudflare Workers. */
export const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

const encoder = new TextEncoder();

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${base64UrlEncode(salt)}$${base64UrlEncode(derived)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1000 || iterations > 5_000_000) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = base64UrlDecode(parts[2]!);
    expected = base64UrlDecode(parts[3]!);
  } catch {
    return false;
  }

  try {
    const actual = await pbkdf2(password, salt, iterations);
    return timingSafeEqual(actual, expected);
  } catch {
    // A legacy hash can carry a work factor that an older Workers runtime no
    // longer accepts. Treat it as a non-match rather than leaking a WebCrypto
    // exception as a 500; resetting that password will write the portable
    // current format above.
    return false;
  }
}

/** True when a stored hash was produced with weaker parameters than current policy. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return true;
  return Number(parts[1]) < PBKDF2_ITERATIONS;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** Constant-time comparison — never use `===` on secrets. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function timingSafeEqualString(a: string, b: string): boolean {
  return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  const data =
    typeof input === 'string'
      ? encoder.encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return toHex(new Uint8Array(digest));
}

export async function sha1Hex(input: Uint8Array): Promise<string> {
  // Required by the Backblaze B2 native upload API (X-Bz-Content-Sha1).
  const digest = await crypto.subtle.digest('SHA-1', input as BufferSource);
  return toHex(new Uint8Array(digest));
}

export async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return new Uint8Array(sig);
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  return toHex(await hmacSha256(secret, message));
}

/** Raw-key HMAC, needed by the AWS SigV4 chain. */
export async function hmacRaw(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return new Uint8Array(sig);
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Privacy-preserving identifier for an IP or user agent.
 * We store only a keyed hash so logs cannot be reversed into personal data.
 */
export async function privacyHash(value: string, salt: string): Promise<string> {
  if (!value) return '';
  return (await hmacSha256Hex(salt || 'ank-social-default-salt', value)).slice(0, 32);
}

/** Basic-auth header value, used by the B2 authorize call. */
export function basicAuth(id: string, key: string): string {
  return `Basic ${btoa(`${id}:${key}`)}`;
}
