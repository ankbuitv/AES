-- ---------------------------------------------------------------------------
-- 0010_reels_messaging — short-form video (Reels) + richer direct messages
--
-- Reels are short vertical videos. Two sources are supported and both live in
-- the same table so one feed can interleave them:
--
--   * `provider = 'upload'`  — the video is ours: `media_id` points at a row in
--     `media`, served through the Worker media gateway like any other object.
--   * everything else        — the video stays on YouTube / TikTok / Instagram /
--     Facebook and is shown through that platform's own embed player. We store
--     only the identifiers needed to build the embed URL, never a copy of the
--     video, which is what keeps this inside each platform's terms of use.
--
-- Messages gain a `kind` so a bubble can be text, an image, a voice clip or a
-- sticker. `content` stays NOT NULL for every kind (it holds the caption, or a
-- short accessible fallback such as "Voice message") so existing readers,
-- previews and search keep working untouched.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reels (
  id            TEXT PRIMARY KEY,
  author_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- 'upload' = self-hosted in our bucket; the rest are embeds.
  provider      TEXT NOT NULL DEFAULT 'upload'
                  CHECK (provider IN ('upload', 'youtube', 'tiktok', 'instagram', 'facebook')),
  -- Platform video id. Empty for uploads. Unique per provider so the same reel
  -- cannot be imported twice.
  external_id   TEXT NOT NULL DEFAULT '',
  -- Canonical page on the source platform ("watch on TikTok").
  source_url    TEXT NOT NULL DEFAULT '',
  -- Fully-built iframe src. Derived server-side, never taken from the client.
  embed_url     TEXT NOT NULL DEFAULT '',
  -- Self-hosted video + poster frame.
  media_id      TEXT REFERENCES media (id) ON DELETE SET NULL,
  poster_url    TEXT NOT NULL DEFAULT '',
  title         TEXT NOT NULL DEFAULT '',
  caption       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'published'
                  CHECK (status IN ('published', 'hidden', 'deleted')),
  view_count    INTEGER NOT NULL DEFAULT 0,
  like_count    INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- The reel feed (newest first) is the hot path; only visible rows are indexed.
CREATE INDEX IF NOT EXISTS idx_reels_feed
  ON reels (created_at DESC, id DESC)
  WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_reels_author
  ON reels (author_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_reels_popular
  ON reels (like_count DESC, created_at DESC)
  WHERE status = 'published';
CREATE UNIQUE INDEX IF NOT EXISTS idx_reels_external
  ON reels (provider, external_id)
  WHERE external_id <> '';

CREATE TABLE IF NOT EXISTS reel_likes (
  reel_id    TEXT NOT NULL REFERENCES reels (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (reel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_reel_likes_user ON reel_likes (user_id, created_at DESC);

-- Rich direct messages -------------------------------------------------------

ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE messages ADD COLUMN media_id TEXT;
-- Voice clip length in milliseconds, so the bubble can show "0:07" before the
-- audio element has loaded any bytes.
ALTER TABLE messages ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;
