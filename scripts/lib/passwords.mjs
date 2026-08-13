/**
 * Node-side password hashing that produces byte-identical output to
 * `src/utils/crypto.ts` (PBKDF2-HMAC-SHA256, 100k iterations, base64url).
 *
 * Keeping the two implementations in the same format is what lets an account
 * created by `npm run create-admin` sign in through the Worker.
 */

import { pbkdf2 as pbkdf2Cb, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2 = promisify(pbkdf2Cb);

// Cloudflare Workers rejects higher PBKDF2 work factors on supported runtime
// configurations. Keep this in lockstep with src/utils/crypto.ts.
export const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const derived = await pbkdf2(password, salt, PBKDF2_ITERATIONS, KEY_BYTES, 'sha256');
  return `pbkdf2$${PBKDF2_ITERATIONS}$${base64Url(salt)}$${base64Url(derived)}`;
}

/** Mirrors `newId()` in src/utils/id.ts: prefix_<base36 time><base36 random>. */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function newId(prefix) {
  const ts = Date.now().toString(36).padStart(9, '0');
  const bytes = randomBytes(10);
  let random = '';
  for (const byte of bytes) random += ALPHABET[byte % 36];
  return `${prefix}_${ts}${random}`;
}

export function slugify(input, maxLength = 60) {
  const base = String(input)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return base || 'post';
}

export function uniqueSlug(title) {
  const bytes = randomBytes(6);
  let suffix = '';
  for (const byte of bytes) suffix += ALPHABET[byte % 36];
  return `${slugify(title)}-${suffix}`;
}
