-- ---------------------------------------------------------------------------
-- 0008_search — SQLite FTS5 index for posts, kept in sync by triggers.
-- This is a real full-text index (D1 ships FTS5), not a LIKE-based fake.
-- The SearchProvider abstraction in src/services/search.ts can be pointed at an
-- external engine later without touching callers.
-- ---------------------------------------------------------------------------

CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5 (
  title,
  content,
  post_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Keep the index in sync with the posts table.
CREATE TRIGGER IF NOT EXISTS posts_fts_insert AFTER INSERT ON posts
WHEN NEW.status = 'published'
BEGIN
  INSERT INTO posts_fts (title, content, post_id)
  VALUES (NEW.title, NEW.content, NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS posts_fts_delete AFTER DELETE ON posts BEGIN
  DELETE FROM posts_fts WHERE post_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS posts_fts_update AFTER UPDATE ON posts BEGIN
  DELETE FROM posts_fts WHERE post_id = OLD.id;
  INSERT INTO posts_fts (title, content, post_id)
  SELECT NEW.title, NEW.content, NEW.id WHERE NEW.status = 'published';
END;

-- Prefix-friendly user search (username / display name) without FTS overhead.
CREATE INDEX IF NOT EXISTS idx_users_display_name ON users (display_name COLLATE NOCASE);
