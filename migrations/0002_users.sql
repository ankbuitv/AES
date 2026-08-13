-- ---------------------------------------------------------------------------
-- 0002_users — accounts, sessions, auth tokens
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  username          TEXT NOT NULL UNIQUE,          -- stored lowercase, [a-z0-9_]{3,24}
  display_name      TEXT NOT NULL,
  email             TEXT NOT NULL UNIQUE,          -- stored lowercase
  password_hash     TEXT NOT NULL,                 -- pbkdf2$iterations$salt$hash
  avatar_media_id   TEXT REFERENCES media (id) ON DELETE SET NULL,
  cover_media_id    TEXT REFERENCES media (id) ON DELETE SET NULL,
  bio               TEXT NOT NULL DEFAULT '',
  location          TEXT NOT NULL DEFAULT '',
  website           TEXT NOT NULL DEFAULT '',
  role              TEXT NOT NULL DEFAULT 'user'
                      CHECK (role IN ('user', 'moderator', 'admin')),
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'suspended', 'banned', 'deleted')),
  status_reason     TEXT NOT NULL DEFAULT '',
  suspended_until   INTEGER,
  level             INTEGER NOT NULL DEFAULT 1,
  xp                INTEGER NOT NULL DEFAULT 0,
  post_count        INTEGER NOT NULL DEFAULT 0,
  comment_count     INTEGER NOT NULL DEFAULT 0,
  -- Reactions this user has *received* on their posts and comments. Kept
  -- denormalised because the "popular" badge and the profile header both read
  -- it on every render; the nightly reconcile cron corrects any drift.
  reaction_received_count INTEGER NOT NULL DEFAULT 0,
  follower_count    INTEGER NOT NULL DEFAULT 0,
  following_count   INTEGER NOT NULL DEFAULT 0,
  email_verified_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_seen_at      INTEGER,
  last_login_at     INTEGER,
  last_xp_daily_at  INTEGER                        -- daily-login XP cooldown
);

CREATE INDEX IF NOT EXISTS idx_users_username     ON users (username);
CREATE INDEX IF NOT EXISTS idx_users_email        ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_created      ON users (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_status_role  ON users (status, role);
-- Leaderboard / "suggested users" ordering.
CREATE INDEX IF NOT EXISTS idx_users_xp           ON users (xp DESC);

-- Session store. Only a hash of the token is persisted; the raw token lives
-- exclusively in the user's HttpOnly cookie.
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,            -- sha-256 of the raw token
  expires_at      INTEGER NOT NULL,
  absolute_expiry INTEGER NOT NULL,                -- hard cap, cannot be extended
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  ip_hash         TEXT NOT NULL DEFAULT '',        -- hmac(ip, IP_HASH_SALT)
  user_agent_hash TEXT NOT NULL DEFAULT '',
  revoked_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_token   ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- Single-use tokens: password reset, email verification.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('password_reset', 'email_verify')),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_user    ON auth_tokens (user_id, kind);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires ON auth_tokens (expires_at);

-- Awarded badges (gamification).
CREATE TABLE IF NOT EXISTS user_badges (
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  badge_code TEXT NOT NULL,
  awarded_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, badge_code)
);

-- Append-only XP ledger — lets us audit and reverse abuse.
CREATE TABLE IF NOT EXISTS xp_events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  amount      INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id   TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_xp_events_user ON xp_events (user_id, created_at DESC);
-- Enforces "XP awarded at most once per (user, reason, target)".
CREATE UNIQUE INDEX IF NOT EXISTS idx_xp_events_unique
  ON xp_events (user_id, reason, target_type, target_id)
  WHERE target_id <> '';
