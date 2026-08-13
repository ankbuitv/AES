/**
 * Crawler-facing endpoints: `robots.txt`, `sitemap.xml` and an RSS `feed.xml`.
 *
 * These are generated from the database rather than shipped as static files so
 * they stay accurate, and they are edge-cached because they contain only
 * public, non-personalised content. The origin is read from configuration —
 * nothing here hard-codes a domain.
 */

import { Hono } from 'hono';
import type { AppContext } from '../../types/env';
import { getConfig, resolveOrigin } from '../../config';
import { serviceContext } from '../../services/context';
import { escapeHtml } from '../../utils/html';
import { toIso } from '../../utils/time';

const seo = new Hono<AppContext>();

/** XML text nodes need the same escaping rules as HTML text nodes. */
function xml(value: string): string {
  return escapeHtml(value);
}

seo.get('/robots.txt', (c) => {
  const origin = resolveOrigin(c.env, c.req.raw);
  const config = getConfig(c.env);

  // Non-production deployments must never be indexed.
  const body = config.isProduction
    ? [
        'User-agent: *',
        'Allow: /',
        'Disallow: /api/',
        'Disallow: /admin',
        'Disallow: /settings',
        'Disallow: /notifications',
        'Disallow: /bookmarks',
        'Disallow: /compose',
        'Disallow: /search',
        'Disallow: /login',
        'Disallow: /register',
        'Disallow: /reset-password',
        'Disallow: /forgot-password',
        '',
        `Sitemap: ${origin}/sitemap.xml`,
        '',
      ].join('\n')
    : ['User-agent: *', 'Disallow: /', ''].join('\n');

  c.header('content-type', 'text/plain; charset=utf-8');
  c.header('cache-control', 'public, max-age=0, s-maxage=3600');
  return c.body(body);
});

seo.get('/sitemap.xml', async (c) => {
  const ctx = serviceContext(c);
  const origin = resolveOrigin(c.env, c.req.raw);

  // Only public, published content is listed, and the list is bounded so the
  // document stays inside the 50k-URL sitemap limit without pagination logic.
  const [posts, tags] = await Promise.all([
    ctx.repos.posts.feed({ viewerId: null, cursor: null, limit: 2000, sort: 'latest' }),
    ctx.repos.tags.listPopular(200),
  ]);

  const staticPaths = ['/', '/explore', '/trending', '/leaderboard', '/status'];

  const urls = [
    ...staticPaths.map(
      (path) =>
        `<url><loc>${xml(origin + path)}</loc><changefreq>hourly</changefreq><priority>${
          path === '/' ? '1.0' : '0.7'
        }</priority></url>`,
    ),
    ...posts.map(
      (post) =>
        `<url><loc>${xml(`${origin}/post/${post.slug}`)}</loc><lastmod>${xml(
          toIso(post.updated_at ?? post.created_at),
        )}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`,
    ),
    ...tags.map(
      (tag) =>
        `<url><loc>${xml(`${origin}/tag/${tag.slug}`)}</loc><changefreq>daily</changefreq><priority>0.4</priority></url>`,
    ),
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`;

  c.header('content-type', 'application/xml; charset=utf-8');
  c.header('cache-control', 'public, max-age=0, s-maxage=1800');
  return c.body(body);
});

seo.get('/feed.xml', async (c) => {
  const ctx = serviceContext(c);
  const config = getConfig(c.env);
  const origin = resolveOrigin(c.env, c.req.raw);

  const posts = await ctx.repos.posts.feed({
    viewerId: null,
    cursor: null,
    limit: 30,
    sort: 'latest',
  });

  const items = posts
    .map((post) => {
      const url = `${origin}/post/${post.slug}`;
      return `    <item>
      <title>${xml(post.title || `Post by @${post.author_username}`)}</title>
      <link>${xml(url)}</link>
      <guid isPermaLink="true">${xml(url)}</guid>
      <pubDate>${xml(new Date(post.created_at * 1000).toUTCString())}</pubDate>
      <dc:creator>${xml(post.author_display_name || post.author_username)}</dc:creator>
      <description>${xml(post.excerpt)}</description>
    </item>`;
    })
    .join('\n');

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(config.siteName)}</title>
    <link>${xml(origin)}</link>
    <atom:link href="${xml(`${origin}/feed.xml`)}" rel="self" type="application/rss+xml" />
    <description>${xml(config.siteDescription)}</description>
    <language>en</language>
    <lastBuildDate>${xml(new Date().toUTCString())}</lastBuildDate>
${items}
  </channel>
</rss>`;

  c.header('content-type', 'application/rss+xml; charset=utf-8');
  c.header('cache-control', 'public, max-age=0, s-maxage=900');
  return c.body(body);
});

export default seo;
