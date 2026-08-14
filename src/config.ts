/**
 * Runtime configuration derived from bindings.
 *
 * Nothing here is hard-coded per-deployment: the site URL, limits and storage
 * provider all come from `[vars]`/secrets, so the same build runs on
 * localhost, *.workers.dev and a custom domain such as https://me.ankb.qzz.io.
 */

import type { Bindings } from './types/env';

export interface AppConfig {
  environment: 'development' | 'preview' | 'production';
  isProduction: boolean;
  siteName: string;
  siteUrl: string;
  siteDescription: string;
  storageProvider: 'b2' | 's3' | 'r2';
  maxUploadBytes: number;
  maxJsonBodyBytes: number;
  allowedUploadMime: string[];
  registrationOpen: boolean;
  logLevel: string;
}

function intVar(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function boolVar(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

export function getConfig(env: Bindings): AppConfig {
  const environment = env.ENVIRONMENT ?? 'development';
  return {
    environment,
    isProduction: environment === 'production',
    siteName: env.SITE_NAME || 'AES',
    siteUrl: (env.SITE_URL || 'http://localhost:8787').replace(/\/+$/, ''),
    siteDescription: env.SITE_DESCRIPTION || 'AES — Ank Ecosystem Social',
    storageProvider: (env.STORAGE_PROVIDER as AppConfig['storageProvider']) || 'r2',
    maxUploadBytes: intVar(env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024),
    maxJsonBodyBytes: intVar(env.MAX_JSON_BODY_BYTES, 256 * 1024),
    allowedUploadMime: (
      env.ALLOWED_UPLOAD_MIME ||
      // Images and short video for posts and reels; audio for voice messages.
      'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,audio/webm,audio/mp4,audio/ogg,audio/mpeg'
    )
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    registrationOpen: boolVar(env.REGISTRATION_OPEN, true),
    logLevel: env.LOG_LEVEL || 'info',
  };
}

/**
 * Canonical origin for links, OpenGraph tags and cookie scope.
 * Prefers the configured SITE_URL; falls back to the request origin so preview
 * deployments and *.workers.dev URLs still generate correct absolute URLs.
 */
export function resolveOrigin(env: Bindings, request: Request): string {
  const configured = (env.SITE_URL || '').replace(/\/+$/, '');
  if (configured && !configured.includes('localhost')) return configured;
  try {
    const url = new URL(request.url);
    return `${url.protocol}//${url.host}`;
  } catch {
    return configured || 'http://localhost:8787';
  }
}

/**
 * Signing secret for CSRF tokens and session-bound HMACs.
 *
 * A configured `SESSION_SECRET` always wins. When it is missing, local
 * development falls back to a fixed dev-only value so `npm run dev` works out
 * of the box: without it every state-changing request — including image
 * uploads — is refused with a CSRF 403 the moment `.dev.vars` is absent.
 *
 * The fallback is NEVER applied outside `ENVIRONMENT === 'development'`.
 * Preview and production require an operator-provided secret and fail closed
 * (mutating requests get a clear CSRF error, never a 500).
 */
const DEV_ONLY_SESSION_SECRET = 'aes-local-dev-only-session-secret';

export function resolveSessionSecret(env: Bindings): string {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (env.ENVIRONMENT === 'development') return DEV_ONLY_SESSION_SECRET;
  return '';
}

// --- Session / auth policy --------------------------------------------------
export const SESSION_COOKIE = 'ank_session';
export const CSRF_COOKIE = 'ank_csrf';
export const THEME_COOKIE = 'ank_theme';

/** Sliding window: a session stays alive while used, up to the absolute cap. */
export const SESSION_IDLE_TTL = 60 * 60 * 24 * 7; // 7 days
export const SESSION_ABSOLUTE_TTL = 60 * 60 * 24 * 30; // 30 days
/** Refresh `last_seen_at`/expiry at most once per this interval (write amplification guard). */
export const SESSION_TOUCH_INTERVAL = 60 * 15;
export const PASSWORD_RESET_TTL = 60 * 30;

// --- Content policy ---------------------------------------------------------
export const LIMITS = {
  usernameMin: 3,
  usernameMax: 24,
  displayNameMax: 48,
  bioMax: 280,
  passwordMin: 10,
  passwordMax: 200,
  postTitleMax: 160,
  postContentMax: 40_000,
  commentContentMax: 4_000,
  messageContentMax: 4_000,
  commentMaxDepth: 4, // 0-indexed → 5 visual levels
  tagsPerPost: 8,
  mediaPerPost: 8,
  reportDescriptionMax: 1_000,
  searchQueryMax: 100,
} as const;

// --- Gamification -----------------------------------------------------------
export const XP_RULES = {
  post: 10,
  comment: 4,
  reactionReceived: 2,
  reactionGiven: 1,
  followReceived: 3,
  dailyLogin: 5,
} as const;

/** Level curve: level N requires 50 * N^1.6 cumulative XP. */
export function levelForXp(xp: number): number {
  let level = 1;
  while (level < 100 && xp >= xpForLevel(level + 1)) level++;
  return level;
}

export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  return Math.round(50 * Math.pow(level - 1, 1.6));
}

export function levelProgress(xp: number): { level: number; current: number; needed: number; pct: number } {
  const level = levelForXp(xp);
  const base = xpForLevel(level);
  const next = xpForLevel(level + 1);
  const current = xp - base;
  const needed = Math.max(1, next - base);
  return { level, current, needed, pct: Math.min(100, Math.round((current / needed) * 100)) };
}

export const BADGES: Record<string, { name: string; description: string; icon: string }> = {
  founder: { name: 'Founder', description: 'One of the first 100 members.', icon: '🌱' },
  first_post: { name: 'First Post', description: 'Published your first post.', icon: '✍️' },
  conversationalist: { name: 'Conversationalist', description: 'Left 25 comments.', icon: '💬' },
  popular: { name: 'Popular', description: 'Earned 100 reactions.', icon: '🔥' },
  connector: { name: 'Connector', description: 'Reached 25 followers.', icon: '🔗' },
  veteran: { name: 'Veteran', description: 'Member for over a year.', icon: '🏅' },
  level_10: { name: 'Level 10', description: 'Reached level 10.', icon: '⭐' },
};
