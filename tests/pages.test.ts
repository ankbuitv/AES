/**
 * Server-rendered pages, SEO surfaces and the moderation dashboard.
 *
 * These tests assert the things a crawler, a screen reader and a moderator
 * depend on: real HTML with landmarks, correct canonical/OpenGraph tags,
 * caching that never leaks a signed-in page into a shared cache, and
 * server-side authorisation on /admin.
 */

import { describe, expect, it } from 'vitest';
import { TestClient } from './helpers/client';

async function html(client: TestClient, path: string) {
  const response = await client.raw(path, { headers: { accept: 'text/html' } });
  return { response, body: await response.text() };
}

describe('server-side rendering', () => {
  it('renders the home feed as complete, landmarked HTML', async () => {
    const client = new TestClient();
    const { response, body } = await html(client, '/');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(body.startsWith('<!doctype html>')).toBe(true);
    expect(body).toContain('<html lang="en"');
    expect(body).toContain('role="banner"');
    expect(body).toContain('<main id="main"');
    expect(body).toContain('class="skip-link"');
    expect(body).toContain('/assets/app.css');
    expect(body).toContain('AES');
    expect(body).toContain('/logo-mark.svg');
    expect(body).toContain('window.__AES__');
  });

  it('renders a post page with article metadata and JSON-LD', async () => {
    const client = new TestClient();
    await client.register({ username: 'ssrauthor' });
    const created = await client.post<{ post: { slug: string } }>('/api/posts', {
      title: 'Server rendered',
      content: 'Indexable from the first byte.',
      contentType: 'markdown',
    });
    const slug = created.body.data!.post.slug;

    const { response, body } = await html(client, `/post/${slug}`);
    expect(response.status).toBe(200);
    expect(body).toContain('<h1');
    expect(body).toContain('Server rendered');
    expect(body).toContain('property="og:type" content="article"');
    expect(body).toContain(`<link rel="canonical" href="http://localhost:8787/post/${slug}">`);
    expect(body).toContain('application/ld+json');
    expect(body).toContain('name="twitter:card"');
  });

  it('renders a profile page for an anonymous visitor', async () => {
    const client = new TestClient();
    await client.register({ username: 'profileview', displayName: 'Profile View' });
    client.reset();

    const { response, body } = await html(client, '/u/profileview');
    expect(response.status).toBe(200);
    expect(body).toContain('Profile View');
    expect(body).toContain('property="og:type" content="profile"');
  });

  it('renders a live, full-width service status dashboard', async () => {
    const client = new TestClient();
    const { response, body } = await html(client, '/status');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(body).toContain('class="status-shell"');
    expect(body).toContain('All systems operational');
    expect(body).toContain('Website &amp; API');
    expect(body).toContain('Media storage');
    expect(body).toContain('Database schema');
    expect(body).toContain('90 days ago');
    expect(body).toContain('data-status-refresh');
    expect(body).toContain('<link rel="canonical" href="http://localhost:8787/status">');
    expect(body).not.toContain('class="sidenav"');
  });

  it('serves the auth, search and error pages', async () => {
    const client = new TestClient();

    expect((await html(client, '/login')).response.status).toBe(200);
    expect((await html(client, '/register')).response.status).toBe(200);

    const search = await html(client, '/search?q=hello');
    expect(search.response.status).toBe(200);
    expect(search.body).toContain('name="q"');

    const missing = await html(client, '/u/doesnotexist');
    expect(missing.response.status).toBe(404);
    expect(missing.body).toContain('404');
  });

  it('redirects an anonymous visitor away from private pages', async () => {
    const client = new TestClient();

    const following = await client.raw('/following', { headers: { accept: 'text/html' } });
    expect([302, 401]).toContain(following.status);

    const settings = await client.raw('/settings', { headers: { accept: 'text/html' } });
    expect(settings.status).toBe(401);
  });
});

describe('caching posture', () => {
  it('never shared-caches a page rendered for a signed-in member', async () => {
    const client = new TestClient();
    await client.register({ username: 'cachetest' });

    const { response } = await html(client, '/');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('allows a short shared cache for anonymous public pages', async () => {
    const client = new TestClient();
    const { response } = await html(client, '/');
    expect(response.headers.get('cache-control')).toContain('s-maxage');
  });

  it('never caches notifications or settings', async () => {
    const client = new TestClient();
    await client.register({ username: 'nocache' });

    for (const path of ['/notifications', '/settings']) {
      const { response } = await html(client, path);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
  });
});

describe('SEO endpoints', () => {
  it('serves robots.txt pointing at the sitemap in production', async () => {
    const client = new TestClient({ ENVIRONMENT: 'production', SITE_URL: 'https://ankb.qzz.io' });
    const response = await client.raw('/robots.txt');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(body).toContain('Sitemap: https://ankb.qzz.io/sitemap.xml');
    expect(body).toContain('Disallow: /api/');
    expect(body).toContain('Disallow: /admin');
  });

  it('keeps non-production deployments out of the index', async () => {
    const client = new TestClient();
    const response = await client.raw('/robots.txt');
    expect(await response.text()).toContain('Disallow: /');
  });

  it('serves a sitemap containing published posts only', async () => {
    const client = new TestClient();
    await client.register({ username: 'sitemapper' });
    const pub = await client.post<{ post: { slug: string } }>('/api/posts', {
      content: 'public post',
    });
    const priv = await client.post<{ post: { slug: string } }>('/api/posts', {
      content: 'private post',
      visibility: 'private',
    });

    const response = await client.raw('/sitemap.xml');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('xml');
    expect(body).toContain('<urlset');
    expect(body).toContain(`/post/${pub.body.data!.post.slug}`);
    expect(body).not.toContain(`/post/${priv.body.data!.post.slug}`);
  });

  it('serves a valid RSS feed', async () => {
    const client = new TestClient();
    await client.register({ username: 'feeder' });
    await client.post('/api/posts', { title: 'RSS item', content: 'in the feed' });

    const response = await client.raw('/feed.xml');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('<rss version="2.0"');
    expect(body).toContain('<title>RSS item</title>');
    expect(body).toContain('<atom:link');
  });

  it('escapes XML special characters in titles', async () => {
    const client = new TestClient();
    await client.register({ username: 'xmlescaper' });
    await client.post('/api/posts', { title: 'Tom & Jerry <script>', content: 'x' });

    const body = await (await client.raw('/feed.xml')).text();
    expect(body).toContain('Tom &amp; Jerry &lt;script&gt;');
    expect(body).not.toContain('<script>');
  });
});

describe('moderation dashboard', () => {
  async function setup() {
    const client = new TestClient();
    await client.register({ username: 'reporter' });
    const post = (
      await client.post<{ post: { id: string; slug: string } }>('/api/posts', {
        content: 'possibly rule-breaking',
      })
    ).body.data!.post;
    return { client, post };
  }

  it('refuses /admin to anonymous visitors and ordinary members', async () => {
    const { client } = await setup();

    const member = await client.raw('/admin', { headers: { accept: 'text/html' } });
    expect(member.status).toBe(403);

    client.reset();
    const anonymous = await client.raw('/admin', { headers: { accept: 'text/html' } });
    expect([401, 403]).toContain(anonymous.status);
  });

  it('refuses the admin API to a non-staff member', async () => {
    const { client } = await setup();
    expect((await client.get('/api/admin/dashboard')).status).toBe(403);
    expect((await client.get('/api/admin/reports')).status).toBe(403);
  });

  it('lets a moderator review a report and records an audit entry', async () => {
    const { client, post } = await setup();

    const reported = await client.post('/api/reports', {
      targetType: 'post',
      targetId: post.id,
      reason: 'spam',
      description: 'looks like spam to me',
    });
    expect(reported.status).toBeLessThan(400);

    client.promote('reporter', 'moderator');
    await client.post('/api/auth/logout');
    await client.login('reporter');

    const dashboard = await client.get<{ stats: { openReports: number } }>('/api/admin/dashboard');
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.data!.stats.openReports).toBeGreaterThan(0);

    const action = await client.post('/api/admin/actions', {
      action: 'hide_post',
      targetId: post.id,
      reason: 'spam',
    });
    expect(action.status).toBeLessThan(400);

    const status = client.env.db.sqlite
      .prepare('SELECT status FROM posts WHERE id = ?')
      .get(post.id) as { status: string };
    expect(status.status).toBe('hidden');

    const audit = client.env.db.sqlite
      .prepare('SELECT COUNT(*) AS n FROM audit_logs')
      .get() as { n: number };
    expect(audit.n).toBeGreaterThan(0);

    const page = await client.raw('/admin?tab=reports', { headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Moderation');
  });

  it('keeps the audit log admin-only', async () => {
    const { client } = await setup();
    client.promote('reporter', 'moderator');
    await client.post('/api/auth/logout');
    await client.login('reporter');

    expect((await client.get('/api/admin/audit')).status).toBe(403);

    client.promote('reporter', 'admin');
    await client.post('/api/auth/logout');
    await client.login('reporter');
    expect((await client.get('/api/admin/audit')).status).toBe(200);
  });

  it('rejects a report for a target that does not exist', async () => {
    const { client } = await setup();
    const result = await client.post('/api/reports', {
      targetType: 'post',
      targetId: 'pst_nothinghere000',
      reason: 'spam',
    });
    expect(result.status).toBeGreaterThanOrEqual(400);
  });
});
