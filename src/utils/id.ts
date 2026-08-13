/**
 * Identifier helpers.
 *
 * IDs are prefixed, time-sortable and URL-safe:
 *   <prefix>_<base36 timestamp><base36 random>
 * Sorting by id therefore approximates sorting by creation time, which makes
 * `(created_at, id)` cursors stable even when two rows share a timestamp.
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomBase36(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i]! % 36];
  }
  return out;
}

export type IdPrefix =
  | 'usr'
  | 'ses'
  | 'pst'
  | 'cmt'
  | 'rct'
  | 'med'
  | 'ntf'
  | 'rpt'
  | 'aud'
  | 'tag'
  | 'job'
  | 'xp'
  | 'tok'
  | 'mnt'
  | 'cln'
  | 'rev'
  | 'opt'
  | 'col'
  | 'cnv'
  | 'msg'
  | 'psh';

export function newId(prefix: IdPrefix): string {
  const ts = Date.now().toString(36).padStart(9, '0');
  return `${prefix}_${ts}${randomBase36(10)}`;
}

/** Cryptographically strong URL-safe token (session tokens, reset tokens). */
export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Build a URL slug from a title.
 * Diacritics are folded so Vietnamese titles produce readable ASCII slugs.
 */
export function slugify(input: string, maxLength = 60): string {
  const base = input
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

/** Slug + short random suffix, guaranteeing uniqueness without a read-then-write race. */
export function uniqueSlug(title: string): string {
  return `${slugify(title)}-${randomBase36(6)}`;
}
