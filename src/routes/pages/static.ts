/**
 * Static informational pages (About, Terms, Privacy).
 *
 * These are linked from the site footer, so they must exist rather than 404.
 * The copy is deliberately short and factual — it describes what this software
 * actually does with data, and an operator is expected to adapt it.
 */

import { Hono } from 'hono';
import type { AppContext } from '../../types/env';
import { getConfig } from '../../config';
import { html, raw } from '../../utils/html';
import { readLimit } from '../../middleware/rateLimit';
import { renderPage, absoluteUrl } from '../../views/render';
import { collectHealthReport } from '../../services/health';
import { loadStatusHistory } from '../../services/statusHistory';
import { renderStatusPage } from '../../views/pages/status';

const staticPages = new Hono<AppContext>();

function page(title: string, sections: { heading: string; body: string }[]): string {
  return html`
    <div class="pagehead">
      <h1 class="pagehead__title">${title}</h1>
    </div>
    <article class="panel prose">
      ${sections.map(
        (section) => raw(html`
          <h2>${section.heading}</h2>
          <p>${section.body}</p>`),
      )}
    </article>
  `;
}

staticPages.get('/about', readLimit(), async (c) => {
  const config = getConfig(c.env);
  return renderPage(c, {
    meta: {
      title: 'About',
      description: `About ${config.siteName}.`,
      canonical: absoluteUrl(c, '/about'),
    },
    body: page(`About ${config.siteName}`, [
      {
        heading: 'What this is',
        body: `${config.siteName} is a small, community-first social platform: short posts, long-form articles, images, links and code snippets, with threaded discussion, reactions, bookmarks and a reputation system.`,
      },
      {
        heading: 'How it is built',
        body: 'The whole application runs on Cloudflare Workers at the edge. Content lives in Cloudflare D1 (SQLite); uploaded files live in object storage and are served through the Worker, never directly from the bucket. Pages are rendered on the server, so the site works with JavaScript disabled and is fully indexable.',
      },
      {
        heading: 'Reputation',
        body: 'Experience points are awarded by the server for publishing, replying and receiving reactions, with cooldowns to discourage farming. Levels and badges are derived from that total — nothing about your standing is computed in your browser.',
      },
      {
        heading: 'Moderation',
        body: 'Anyone can report a post, comment, account or file. Reports go to a queue reviewed by moderators, and every moderation action is written to an append-only audit log.',
      },
    ]),
    cacheSeconds: 3600,
  });
});

staticPages.get('/terms', readLimit(), async (c) => {
  const config = getConfig(c.env);
  return renderPage(c, {
    meta: {
      title: 'Terms',
      description: `Terms of use for ${config.siteName}.`,
      canonical: absoluteUrl(c, '/terms'),
    },
    body: page('Terms of use', [
      {
        heading: 'Your account',
        body: 'You are responsible for what you publish and for keeping your credentials safe. One person, one account; do not impersonate anyone else. Accounts may be suspended or removed for breaking these terms.',
      },
      {
        heading: 'Acceptable content',
        body: 'No harassment, hate speech, threats, sexual content involving minors, spam, malware or content you have no right to publish. Uploads are limited to images; executable files, scripts and markup are rejected at upload time.',
      },
      {
        heading: 'Your content',
        body: 'You keep ownership of everything you post. By publishing here you grant this site permission to store and display it so that it can be shown to other members. Deleting a post removes it from the site; backups and caches may lag briefly.',
      },
      {
        heading: 'No warranty',
        body: 'This service is provided as is, without warranty of any kind. It may change or be discontinued at any time.',
      },
    ]),
    cacheSeconds: 3600,
  });
});

staticPages.get('/privacy', readLimit(), async (c) => {
  const config = getConfig(c.env);
  return renderPage(c, {
    meta: {
      title: 'Privacy',
      description: `How ${config.siteName} handles your data.`,
      canonical: absoluteUrl(c, '/privacy'),
    },
    body: page('Privacy', [
      {
        heading: 'What is stored',
        body: 'Your username, display name, email address, a salted hash of your password (never the password itself), your profile fields, and the content you publish. Uploaded images are stored in object storage; the database keeps only their metadata.',
      },
      {
        heading: 'Sessions and security data',
        body: 'A session is a random token kept in an HttpOnly cookie; only a hash of it is stored on the server. IP addresses and user agents are recorded as keyed hashes for abuse prevention, so they cannot be read back as personal data.',
      },
      {
        heading: 'Third parties',
        body: 'There are no advertising or analytics trackers, no third-party fonts and no external scripts. Requests are served by Cloudflare, which processes them as an infrastructure provider.',
      },
      {
        heading: 'Deleting your data',
        body: 'Settings → Danger zone deletes your account. Your profile and posts are removed from the site, your sessions are revoked and your uploaded files are queued for permanent deletion from storage.',
      },
    ]),
    cacheSeconds: 3600,
  });
});

staticPages.get('/status', readLimit(), async (c) => {
  const config = getConfig(c.env);
  const [report, history] = await Promise.all([
    collectHealthReport(c.env),
    loadStatusHistory(c.env),
  ]);

  return renderPage(c, {
    meta: {
      title: 'Service status',
      description: `Live uptime and service status for ${config.siteName}.`,
      canonical: absoluteUrl(c, '/status'),
    },
    body: renderStatusPage({ siteName: config.siteName, report, history }),
    layout: 'status',
  });
});

export default staticPages;
