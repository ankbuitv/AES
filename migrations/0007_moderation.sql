-- ---------------------------------------------------------------------------
-- 0007_moderation — reports, audit logs, blocks
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reports (
  id           TEXT PRIMARY KEY,
  reporter_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL CHECK (target_type IN ('post', 'comment', 'user', 'media')),
  target_id    TEXT NOT NULL,
  reason       TEXT NOT NULL CHECK (reason IN
                 ('spam', 'harassment', 'hate', 'nsfw', 'violence',
                  'misinformation', 'copyright', 'other')),
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'reviewing', 'resolved', 'rejected')),
  resolution   TEXT NOT NULL DEFAULT '',
  reviewed_by  TEXT REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at  INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_status  ON reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_target  ON reports (target_type, target_id);
-- One open report per user per target — stops report spam at the DB level.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_reporter_target
  ON reports (reporter_id, target_type, target_id)
  WHERE status IN ('open', 'reviewing');

-- Append-only audit trail for every privileged action.
CREATE TABLE IF NOT EXISTS audit_logs (
  id            TEXT PRIMARY KEY,
  actor_id      TEXT REFERENCES users (id) ON DELETE SET NULL,
  action        TEXT NOT NULL,     -- e.g. post.hide, user.suspend, report.resolve
  target_type   TEXT NOT NULL DEFAULT '',
  target_id     TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  ip_hash       TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target  ON audit_logs (target_type, target_id, created_at DESC);

-- User-level blocks (mutual content hiding).
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks (blocked_id);
