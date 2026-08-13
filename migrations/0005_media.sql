-- ---------------------------------------------------------------------------
-- 0005_media — object-storage metadata (binaries live in B2, never in D1)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS media (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  storage_key   TEXT NOT NULL,                 -- object key inside the bucket ("b2_key")
  storage_provider TEXT NOT NULL DEFAULT 'b2', -- b2 | s3 | r2
  original_name TEXT NOT NULL DEFAULT '',
  mime_type     TEXT NOT NULL,                 -- sniffed from bytes, not from the browser
  size          INTEGER NOT NULL,
  width         INTEGER,
  height        INTEGER,
  checksum      TEXT NOT NULL DEFAULT '',      -- sha-256 hex of the object bytes
  variant       TEXT NOT NULL DEFAULT 'original'
                  CHECK (variant IN ('original', 'thumb', 'medium')),
  parent_id     TEXT REFERENCES media (id) ON DELETE CASCADE, -- set on derived variants
  visibility    TEXT NOT NULL DEFAULT 'public'
                  CHECK (visibility IN ('public', 'followers', 'private')),
  status        TEXT NOT NULL DEFAULT 'ready'
                  CHECK (status IN ('pending', 'ready', 'processing', 'missing', 'deleted')),
  usage_context TEXT NOT NULL DEFAULT 'attachment'
                  CHECK (usage_context IN ('avatar', 'cover', 'post', 'attachment')),
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_media_owner   ON media (owner_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_key ON media (storage_key);
CREATE INDEX IF NOT EXISTS idx_media_status  ON media (status, created_at);
CREATE INDEX IF NOT EXISTS idx_media_parent  ON media (parent_id, variant);
CREATE INDEX IF NOT EXISTS idx_media_checksum ON media (owner_id, checksum);

-- Objects whose D1 row is gone but whose bytes may still exist in the bucket.
-- Drained by the nightly cron / queue consumer.
CREATE TABLE IF NOT EXISTS storage_cleanup_queue (
  id           TEXT PRIMARY KEY,
  storage_key  TEXT NOT NULL,
  provider     TEXT NOT NULL DEFAULT 'b2',
  reason       TEXT NOT NULL DEFAULT '',
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  processed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cleanup_pending
  ON storage_cleanup_queue (created_at)
  WHERE processed_at IS NULL;
