/**
 * Schema bootstrap: an empty D1 must become a working database from the
 * bundled migration files — the same files Wrangler applies remotely.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_MIGRATIONS, ensureSchema } from '../src/db/schema';
import { TestClient } from './helpers/client';
import { createEmptyDatabase } from './helpers/d1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('bundled migrations', () => {
  it('tracks every file in /migrations', () => {
    const files = readdirSync(path.join(root, 'migrations'))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    expect(BUNDLED_MIGRATIONS.map((m) => m.name)).toEqual(files);
  });

  it('applies the full schema to an empty database', async () => {
    const db = createEmptyDatabase();
    const status = await ensureSchema(db as unknown as D1Database);

    expect(status.ok).toBe(true);
    expect(status.ready).toBe(true);
    expect(status.pending).toEqual([]);
    expect(status.applied.length).toBe(BUNDLED_MIGRATIONS.length);

    const posts = db.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='posts'`).get() as
      | { name: string }
      | undefined;
    expect(posts?.name).toBe('posts');

    const categories = db.sqlite.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number };
    expect(categories.n).toBeGreaterThan(0);
  });

  it('is a no-op on a second call', async () => {
    const db = createEmptyDatabase();
    await ensureSchema(db as unknown as D1Database);
    const again = await ensureSchema(db as unknown as D1Database);
    expect(again.ok).toBe(true);
    expect(again.pending).toEqual([]);
  });
});

describe('empty production-like database', () => {
  it('serves the homepage after bootstrapping schema', async () => {
    const client = new TestClient({}, { empty: true });
    const response = await client.raw('/', { headers: { accept: 'text/html' } });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('AES');
    expect(body).not.toContain('Database error');
    expect(body).toContain('Nothing here yet');
  });

  it('lists categories from the seeded taxonomy', async () => {
    const client = new TestClient({}, { empty: true });
    const response = await client.get<{ categories: { slug: string }[] }>('/api/categories');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data?.categories.some((row) => row.slug === 'general')).toBe(true);
  });

  it('returns an empty feed instead of 500', async () => {
    const client = new TestClient({}, { empty: true });
    const response = await client.get('/api/posts');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it('reports schema ok from /health', async () => {
    const client = new TestClient({}, { empty: true });
    const response = await client.raw('/health');
    const body = (await response.json()) as { status: string; checks: Record<string, string> };
    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.checks.database).toBe('ok');
    expect(body.checks.schema).toBe('ok');
  });
});
