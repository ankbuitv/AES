/**
 * Tags, categories and application settings.
 */

import { Db, placeholders } from '../client';
import { newId, slugify } from '../../utils/id';
import { now } from '../../utils/time';

export interface TagRow {
  id: string;
  slug: string;
  name: string;
  post_count: number;
  created_at: number;
}

export interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  color: string;
  post_count: number;
  created_at: number;
}

export class TagRepository {
  constructor(private readonly db: Db) {}

  async findBySlug(slug: string): Promise<TagRow | null> {
    return this.db.first<TagRow>('SELECT * FROM tags WHERE slug = ?', [slug.toLowerCase()]);
  }

  /**
   * Resolve hashtag names to tag ids, creating any that do not exist.
   * `INSERT OR IGNORE` makes concurrent creation of the same tag safe.
   */
  async ensureMany(names: string[]): Promise<TagRow[]> {
    const normalised = new Map<string, string>();
    for (const raw of names) {
      const slug = slugify(raw.replace(/^#/, ''), 40);
      if (slug && slug !== 'post') normalised.set(slug, raw.replace(/^#/, '').slice(0, 40));
    }
    if (!normalised.size) return [];

    const slugs = [...normalised.keys()];
    const ts = now();
    await this.db.batch(
      slugs.map((slug) => ({
        sql: 'INSERT OR IGNORE INTO tags (id, slug, name, created_at) VALUES (?, ?, ?, ?)',
        params: [newId('tag'), slug, normalised.get(slug) ?? slug, ts] as (string | number)[],
      })),
    );

    return this.db.all<TagRow>(
      `SELECT * FROM tags WHERE slug IN (${placeholders(slugs.length)})`,
      slugs,
    );
  }

  async incrementCounts(tagIds: string[], delta: number): Promise<void> {
    if (!tagIds.length) return;
    await this.db.run(
      `UPDATE tags SET post_count = MAX(0, post_count + ?) WHERE id IN (${placeholders(tagIds.length)})`,
      [delta, ...tagIds],
    );
  }

  /** Trending tags: usage within the recent window, not all-time totals. */
  async trending(limit = 10, sinceSeconds = 60 * 60 * 24 * 7): Promise<TagRow[]> {
    return this.db.all<TagRow>(
      `SELECT t.id, t.slug, t.name, t.created_at, COUNT(pt.post_id) AS post_count
       FROM tags t
       JOIN post_tags pt ON pt.tag_id = t.id
       JOIN posts p ON p.id = pt.post_id
       WHERE pt.created_at > ? AND p.status = 'published' AND p.visibility = 'public'
       GROUP BY t.id
       ORDER BY post_count DESC, t.slug ASC
       LIMIT ?`,
      [now() - sinceSeconds, limit],
    );
  }

  async search(query: string, limit: number): Promise<TagRow[]> {
    const like = `${query.toLowerCase().replace(/[%_#]/g, '')}%`;
    return this.db.all<TagRow>(
      'SELECT * FROM tags WHERE slug LIKE ? ORDER BY post_count DESC LIMIT ?',
      [like, limit],
    );
  }

  async listPopular(limit = 20): Promise<TagRow[]> {
    return this.db.all<TagRow>(
      'SELECT * FROM tags WHERE post_count > 0 ORDER BY post_count DESC, slug ASC LIMIT ?',
      [limit],
    );
  }
}

export class CategoryRepository {
  constructor(private readonly db: Db) {}

  async list(): Promise<CategoryRow[]> {
    return this.db.all<CategoryRow>('SELECT * FROM categories ORDER BY name ASC');
  }

  async findBySlug(slug: string): Promise<CategoryRow | null> {
    return this.db.first<CategoryRow>('SELECT * FROM categories WHERE slug = ?', [slug]);
  }

  async findById(id: string): Promise<CategoryRow | null> {
    return this.db.first<CategoryRow>('SELECT * FROM categories WHERE id = ?', [id]);
  }

  async incrementCount(id: string, delta: number): Promise<void> {
    await this.db.run('UPDATE categories SET post_count = MAX(0, post_count + ?) WHERE id = ?', [
      delta,
      id,
    ]);
  }
}

export class SettingsRepository {
  constructor(private readonly db: Db) {}

  async all(): Promise<Record<string, string>> {
    const rows = await this.db.all<{ key: string; value: string }>(
      'SELECT key, value FROM settings',
    );
    const out: Record<string, string> = {};
    for (const row of rows) out[row.key] = row.value;
    return out;
  }

  async get(key: string): Promise<string | null> {
    const row = await this.db.first<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      key,
    ]);
    return row?.value ?? null;
  }

  async getBoolean(key: string, fallback: boolean): Promise<boolean> {
    const value = await this.get(key);
    if (value === null) return fallback;
    return value === 'true' || value === '1';
  }

  async set(key: string, value: string, updatedBy: string | null): Promise<void> {
    await this.db.run(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value,
                                       updated_at = excluded.updated_at,
                                       updated_by = excluded.updated_by`,
      [key, value, now(), updatedBy],
    );
  }
}
