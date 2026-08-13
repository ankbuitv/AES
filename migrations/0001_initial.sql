-- ---------------------------------------------------------------------------
-- 0001_initial — foundational tables: settings, tags, categories
-- ---------------------------------------------------------------------------
PRAGMA foreign_keys = ON;

-- Key/value application settings, editable from the admin panel.
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('registration_open',   'true', unixepoch()),
  ('site_announcement',   '',     unixepoch()),
  ('max_upload_bytes',    '10485760', unixepoch()),
  ('feed_default_limit',  '15',   unixepoch());

-- Categories: a small, admin-curated taxonomy for posts.
CREATE TABLE IF NOT EXISTS categories (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '#6366f1',
  post_count  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- Tags / hashtags: user generated, normalised to lowercase.
CREATE TABLE IF NOT EXISTS tags (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,   -- normalised lowercase, no '#'
  name        TEXT NOT NULL,          -- display form, first-seen casing
  post_count  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- Trending lookups: hot tags ordered by usage.
CREATE INDEX IF NOT EXISTS idx_tags_post_count ON tags (post_count DESC);

INSERT OR IGNORE INTO categories (id, slug, name, description, color, created_at) VALUES
  ('cat_general',   'general',   'General',   'Anything and everything.',        '#6366f1', unixepoch()),
  ('cat_dev',       'dev',       'Dev',       'Code, tooling and engineering.',  '#22d3ee', unixepoch()),
  ('cat_design',    'design',    'Design',    'UI, UX and visual work.',         '#f472b6', unixepoch()),
  ('cat_showcase',  'showcase',  'Showcase',  'Show what you built.',            '#34d399', unixepoch()),
  ('cat_questions', 'questions', 'Questions', 'Ask the community.',              '#fbbf24', unixepoch());
