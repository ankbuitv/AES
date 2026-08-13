-- ---------------------------------------------------------------------------
-- 0004_social — reactions, follows, bookmarks, mentions, views
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reactions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  target_type   TEXT NOT NULL CHECK (target_type IN ('post', 'comment')),
  target_id     TEXT NOT NULL,
  reaction_type TEXT NOT NULL DEFAULT 'like'
                  CHECK (reaction_type IN ('like', 'love', 'insightful', 'funny', 'sad')),
  created_at    INTEGER NOT NULL
);

-- One reaction per user per target (changing the type updates in place).
CREATE UNIQUE INDEX IF NOT EXISTS idx_reactions_unique
  ON reactions (user_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_reactions_target
  ON reactions (target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reactions_user
  ON reactions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS follows (
  follower_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  following_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id <> following_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_follower  ON follows (follower_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows (following_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bookmarks (
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  post_id    TEXT NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookmarks_post ON bookmarks (post_id);

-- @mentions extracted server-side from post/comment content.
CREATE TABLE IF NOT EXISTS mentions (
  id           TEXT PRIMARY KEY,
  source_type  TEXT NOT NULL CHECK (source_type IN ('post', 'comment')),
  source_id    TEXT NOT NULL,
  mentioned_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mentions_unique
  ON mentions (source_type, source_id, mentioned_id);
CREATE INDEX IF NOT EXISTS idx_mentions_user
  ON mentions (mentioned_id, created_at DESC);

-- De-duplicated view counter (one view per viewer key per post per window).
CREATE TABLE IF NOT EXISTS post_views (
  post_id     TEXT NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  viewer_key  TEXT NOT NULL,      -- user id, or hashed ip+ua for anonymous
  viewed_at   INTEGER NOT NULL,
  PRIMARY KEY (post_id, viewer_key)
);

CREATE INDEX IF NOT EXISTS idx_post_views_time ON post_views (viewed_at);
