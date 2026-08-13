-- ---------------------------------------------------------------------------
-- 0003_posts — posts, post↔tag/media relations, comments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS posts (
  id             TEXT PRIMARY KEY,
  author_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  category_id    TEXT REFERENCES categories (id) ON DELETE SET NULL,
  title          TEXT NOT NULL DEFAULT '',
  slug           TEXT NOT NULL UNIQUE,
  content        TEXT NOT NULL,                    -- raw user input, never trusted
  excerpt        TEXT NOT NULL DEFAULT '',
  content_type   TEXT NOT NULL DEFAULT 'text'
                   CHECK (content_type IN ('text', 'markdown', 'article', 'image', 'link', 'code')),
  link_url       TEXT NOT NULL DEFAULT '',         -- for link posts
  code_language  TEXT NOT NULL DEFAULT '',         -- for code posts
  visibility     TEXT NOT NULL DEFAULT 'public'
                   CHECK (visibility IN ('public', 'followers', 'private')),
  status         TEXT NOT NULL DEFAULT 'published'
                   CHECK (status IN ('published', 'draft', 'hidden', 'deleted')),
  views          INTEGER NOT NULL DEFAULT 0,
  comment_count  INTEGER NOT NULL DEFAULT 0,
  reaction_count INTEGER NOT NULL DEFAULT 0,
  bookmark_count INTEGER NOT NULL DEFAULT 0,
  share_count    INTEGER NOT NULL DEFAULT 0,
  hot_score      REAL NOT NULL DEFAULT 0,          -- recomputed by cron for /trending
  -- Author or moderator can close a thread without deleting it.
  comments_locked INTEGER NOT NULL DEFAULT 0 CHECK (comments_locked IN (0, 1)),
  pinned_at      INTEGER,                          -- author pin on their profile
  edited_at      INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Feed queries (the hot path). Partial indexes keep them small: only rows a
-- public feed can ever return are indexed.
CREATE INDEX IF NOT EXISTS idx_posts_feed
  ON posts (created_at DESC, id DESC)
  WHERE status = 'published' AND visibility = 'public';
CREATE INDEX IF NOT EXISTS idx_posts_author
  ON posts (author_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_author_status
  ON posts (author_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_trending
  ON posts (hot_score DESC, created_at DESC)
  WHERE status = 'published' AND visibility = 'public';
CREATE INDEX IF NOT EXISTS idx_posts_category
  ON posts (category_id, created_at DESC)
  WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_posts_slug   ON posts (slug);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts (status, created_at DESC);

-- Post ↔ tag join table.
CREATE TABLE IF NOT EXISTS post_tags (
  post_id    TEXT NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  tag_id     TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON post_tags (tag_id, created_at DESC);

-- Ordered media attached to a post.
CREATE TABLE IF NOT EXISTS post_media (
  post_id    TEXT NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  media_id   TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,
  alt_text   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (post_id, media_id)
);

CREATE INDEX IF NOT EXISTS idx_post_media_post  ON post_media (post_id, position);
CREATE INDEX IF NOT EXISTS idx_post_media_media ON post_media (media_id);

CREATE TABLE IF NOT EXISTS comments (
  id             TEXT PRIMARY KEY,
  post_id        TEXT NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  author_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  parent_id      TEXT REFERENCES comments (id) ON DELETE CASCADE,
  root_id        TEXT,                             -- top-level ancestor, for thread fetch
  depth          INTEGER NOT NULL DEFAULT 0,       -- 0..4, enforced in the service layer
  content        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'published'
                   CHECK (status IN ('published', 'hidden', 'deleted')),
  reaction_count INTEGER NOT NULL DEFAULT 0,
  reply_count    INTEGER NOT NULL DEFAULT 0,
  edited_at      INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_post   ON comments (post_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_comments_thread ON comments (post_id, root_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_comments_author ON comments (author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments (parent_id, created_at ASC);
