-- Extra community features: polls, quotes, mutes, DMs, collections,
-- revisions, scheduled posts, tag follows, push subscriptions.

CREATE TABLE IF NOT EXISTS post_revisions (
  id          TEXT PRIMARY KEY,
  post_id     TEXT NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL,
  edited_by   TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_post ON post_revisions (post_id, created_at DESC);

ALTER TABLE posts ADD COLUMN scheduled_at INTEGER;
ALTER TABLE posts ADD COLUMN quote_post_id TEXT;
CREATE INDEX IF NOT EXISTS idx_posts_scheduled
  ON posts (scheduled_at)
  WHERE scheduled_at IS NOT NULL AND status = 'draft';

CREATE TABLE IF NOT EXISTS poll_options (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  vote_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_poll_options_post ON poll_options (post_id, position);

CREATE TABLE IF NOT EXISTS poll_votes (
  post_id    TEXT NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  option_id  TEXT NOT NULL REFERENCES poll_options (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS mutes (
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('user', 'word')),
  target_id   TEXT NOT NULL DEFAULT '',
  word        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, target_id, word)
);
CREATE INDEX IF NOT EXISTS idx_mutes_user ON mutes (user_id);

CREATE TABLE IF NOT EXISTS tag_follows (
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tag_id     TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_tag_follows_tag ON tag_follows (tag_id);

CREATE TABLE IF NOT EXISTS bookmark_collections (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_collections_user ON bookmark_collections (user_id, created_at DESC);

ALTER TABLE bookmarks ADD COLUMN collection_id TEXT;

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  last_read_at    INTEGER,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conversation_members (user_id, conversation_id);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  sender_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS user_prefs (
  user_id        TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  email_digest   INTEGER NOT NULL DEFAULT 1 CHECK (email_digest IN (0, 1)),
  digest_last_at INTEGER
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  keys_json  TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions (user_id);
