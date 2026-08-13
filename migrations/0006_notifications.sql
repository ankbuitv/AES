-- ---------------------------------------------------------------------------
-- 0006_notifications — user notifications + background job queue fallback
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE, -- recipient
  actor_id    TEXT REFERENCES users (id) ON DELETE CASCADE,          -- who caused it
  type        TEXT NOT NULL CHECK (type IN
                ('FOLLOW', 'LIKE', 'COMMENT', 'REPLY', 'MENTION', 'SYSTEM', 'MODERATION')),
  target_type TEXT NOT NULL DEFAULT '',
  target_id   TEXT NOT NULL DEFAULT '',
  data_json   TEXT NOT NULL DEFAULT '{}',
  read_at     INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_user
  ON notifications (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;
-- Collapse duplicate notifications (e.g. like → unlike → like).
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
  ON notifications (user_id, actor_id, type, target_type, target_id)
  WHERE target_id <> '' AND actor_id IS NOT NULL;

-- Durable job table. Used when Cloudflare Queues is not bound (free plan);
-- the same payload shape is sent to Queues when it is available.
CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT NOT NULL DEFAULT '',
  run_after    INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_pending
  ON jobs (run_after)
  WHERE status = 'pending';

-- Daily rollups produced by the nightly cron; powers the admin dashboard.
CREATE TABLE IF NOT EXISTS stats_daily (
  day            TEXT PRIMARY KEY,   -- YYYY-MM-DD (UTC)
  new_users      INTEGER NOT NULL DEFAULT 0,
  new_posts      INTEGER NOT NULL DEFAULT 0,
  new_comments   INTEGER NOT NULL DEFAULT 0,
  new_reactions  INTEGER NOT NULL DEFAULT 0,
  active_users   INTEGER NOT NULL DEFAULT 0,
  media_bytes    INTEGER NOT NULL DEFAULT 0,
  computed_at    INTEGER NOT NULL
);
