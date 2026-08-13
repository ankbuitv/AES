#!/usr/bin/env node
/**
 * Seed the database with a small, realistic dataset so a fresh install has
 * something to render: five members, tags, posts of every content type,
 * threaded comments, reactions, follows and bookmarks.
 *
 *   npm run seed                 # local dev database
 *   npm run seed:remote          # remote preview database
 *
 * Every account gets the same demo password, printed at the end. This is a
 * development convenience only; the script refuses to target production.
 */

import { execSql, nowSeconds, parseTarget, q } from './lib/d1.mjs';
import { hashPassword, newId, slugify, uniqueSlug } from './lib/passwords.mjs';

const target = parseTarget();
const DEMO_PASSWORD = 'ChangeMe!2026';

if (target.remote && target.env !== 'preview') {
  console.error('Refusing to seed the production database. Remote seeds must use --env preview.');
  process.exit(1);
}

const ts = nowSeconds();
const hash = await hashPassword(DEMO_PASSWORD);

const people = [
  {
    username: 'ank',
    displayName: 'Ank',
    email: 'ank@example.com',
    role: 'admin',
    bio: 'Building AnkSocial on Cloudflare Workers. Coffee, code, and long changelogs.',
    location: 'Bien Hoa, VN',
    website: 'https://example.com',
  },
  {
    username: 'mira',
    displayName: 'Mira Tan',
    email: 'mira@example.com',
    role: 'moderator',
    bio: 'Design systems, typography, and keeping the community kind.',
    location: 'Singapore',
    website: '',
  },
  {
    username: 'dev_kai',
    displayName: 'Kai',
    email: 'kai@example.com',
    role: 'user',
    bio: 'Edge runtimes and SQLite tricks.',
    location: 'Berlin',
    website: '',
  },
  {
    username: 'lan',
    displayName: 'Lan Nguyen',
    email: 'lan@example.com',
    role: 'user',
    bio: 'Writes about product, ships on Fridays anyway.',
    location: 'Ha Noi',
    website: '',
  },
  {
    username: 'sora',
    displayName: 'Sora',
    email: 'sora@example.com',
    role: 'user',
    bio: 'Photography and small tools.',
    location: 'Osaka',
    website: '',
  },
].map((person) => ({ ...person, id: newId('usr') }));

const tags = [
  'workers',
  'd1',
  'design',
  'typescript',
  'edge',
  'community',
  'sqlite',
  'accessibility',
].map((name) => ({ id: newId('tag'), slug: slugify(name), name }));

const posts = [
  {
    author: 'ank',
    category: 'general',
    contentType: 'markdown',
    title: 'Welcome to AnkSocial',
    content: `This is a small community platform that runs entirely at the edge — no origin server, no VPS, no PHP.

**What is here already**

- Posts, comments up to five levels deep, reactions and bookmarks
- Follows, mentions and notifications
- Server-computed XP, levels and badges
- Media served through the Worker, never straight from the bucket

Say hello with a post, and use #community for meta discussion.`,
    tags: ['community', 'workers'],
  },
  {
    author: 'dev_kai',
    category: 'dev',
    contentType: 'article',
    title: 'Keyset pagination in D1, and why OFFSET dies at scale',
    content: `\`LIMIT ... OFFSET n\` makes SQLite walk and discard n rows. On a feed table that grows every day, page 200 costs two hundred times page one.

## The fix

Sort by a stable, unique compound key and remember the last one you saw:

\`\`\`sql
SELECT * FROM posts
WHERE (created_at < ?1 OR (created_at = ?1 AND id < ?2))
ORDER BY created_at DESC, id DESC
LIMIT ?3;
\`\`\`

Encode \`(created_at, id)\` into an opaque cursor and hand it back to the client. Constant cost per page, no duplicates when new rows arrive mid-scroll, and the index does all of the work.`,
    tags: ['d1', 'sqlite', 'edge'],
  },
  {
    author: 'mira',
    category: 'design',
    contentType: 'markdown',
    title: 'Focus rings are not decoration',
    content: `Removing \`:focus\` styles is the single fastest way to make a site unusable by keyboard.

Use \`:focus-visible\` so pointer users never see the ring, keyboard users always do, and nobody has to argue about it in review. Pair it with a 3:1 contrast against the adjacent surface and you are done.`,
    tags: ['design', 'accessibility'],
  },
  {
    author: 'lan',
    category: 'showcase',
    contentType: 'link',
    title: 'Cloudflare D1 documentation',
    content: 'The pricing and limits page is worth reading before you design your schema.',
    linkUrl: 'https://developers.cloudflare.com/d1/',
    tags: ['d1'],
  },
  {
    author: 'sora',
    category: 'dev',
    contentType: 'code',
    title: 'Tiny helper: constant-time string compare',
    content: `export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}`,
    codeLanguage: 'typescript',
    tags: ['typescript'],
  },
  {
    author: 'ank',
    category: 'questions',
    contentType: 'markdown',
    title: '',
    content:
      'What should the default feed be for a brand new visitor — newest, or the trending mix? I keep flip-flopping. /cc @mira @dev_kai',
    tags: ['community'],
  },
].map((post) => ({ ...post, id: newId('pst'), slug: uniqueSlug(post.title || post.content) }));

const comments = [
  { post: 0, author: 'mira', content: 'Congratulations on the launch! The keyboard navigation is already solid.' },
  { post: 0, author: 'dev_kai', content: 'The `/media` proxy with range support is a nice touch.' },
  { post: 1, author: 'lan', content: 'This finally made cursors click for me. The compound key was the missing piece.' },
  { post: 1, author: 'ank', content: 'The other half is never trusting a client-supplied cursor — decode, validate, bound it.' },
  { post: 2, author: 'sora', content: 'Adding `:focus-visible` to my template right now.' },
  { post: 5, author: 'dev_kai', content: 'Trending, but only until the visitor follows five people.' },
].map((comment) => ({ ...comment, id: newId('cmt') }));

const byUsername = new Map(people.map((person) => [person.username, person]));

const statements = [];

// --- People ---------------------------------------------------------------
for (const [index, person] of people.entries()) {
  statements.push(`INSERT OR IGNORE INTO users
      (id, username, display_name, email, password_hash, bio, location, website,
       role, status, level, xp, created_at, updated_at, last_seen_at, email_verified_at)
    VALUES (${q(person.id)}, ${q(person.username)}, ${q(person.displayName)}, ${q(person.email)},
       ${q(hash)}, ${q(person.bio)}, ${q(person.location)}, ${q(person.website)},
       ${q(person.role)}, 'active', 1, 0,
       ${ts - (people.length - index) * 86400}, ${ts}, ${ts}, ${ts});`);
}

// --- Tags -----------------------------------------------------------------
for (const tag of tags) {
  statements.push(
    `INSERT OR IGNORE INTO tags (id, slug, name, post_count, created_at)
     VALUES (${q(tag.id)}, ${q(tag.slug)}, ${q(tag.name)}, 0, ${ts});`,
  );
}

// --- Posts ----------------------------------------------------------------
for (const [index, post] of posts.entries()) {
  const author = byUsername.get(post.author);
  const createdAt = ts - (posts.length - index) * 5400;
  const excerpt = post.content.replace(/[#*`>\-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

  statements.push(`INSERT OR IGNORE INTO posts
      (id, author_id, category_id, title, slug, content, excerpt, content_type,
       link_url, code_language, visibility, status, views, hot_score, created_at, updated_at)
    VALUES (${q(post.id)}, ${q(author.id)}, ${q(`cat_${post.category === 'general' ? 'general' : post.category}`)},
       ${q(post.title ?? '')}, ${q(post.slug)}, ${q(post.content)}, ${q(excerpt)}, ${q(post.contentType)},
       ${q(post.linkUrl ?? '')}, ${q(post.codeLanguage ?? '')}, 'public', 'published',
       ${20 + index * 7}, ${(posts.length - index) * 1.5}, ${createdAt}, ${createdAt});`);

  for (const tagName of post.tags ?? []) {
    const tag = tags.find((t) => t.slug === slugify(tagName));
    if (!tag) continue;
    statements.push(
      `INSERT OR IGNORE INTO post_tags (post_id, tag_id, created_at) VALUES (${q(post.id)}, ${q(tag.id)}, ${createdAt});`,
    );
  }
}

// --- Comments (one nested reply chain) ------------------------------------
for (const [index, comment] of comments.entries()) {
  const post = posts[comment.post];
  const author = byUsername.get(comment.author);
  const createdAt = ts - (comments.length - index) * 900;
  // Every second comment replies to the previous one, producing real depth.
  const parent = index > 0 && comments[index - 1].post === comment.post ? comments[index - 1] : null;

  statements.push(`INSERT OR IGNORE INTO comments
      (id, post_id, author_id, parent_id, root_id, depth, content, status, created_at, updated_at)
    VALUES (${q(comment.id)}, ${q(post.id)}, ${q(author.id)}, ${q(parent?.id ?? null)},
       ${q(parent?.id ?? comment.id)}, ${parent ? 1 : 0}, ${q(comment.content)}, 'published',
       ${createdAt}, ${createdAt});`);
}

// --- Reactions, follows, bookmarks ----------------------------------------
for (const [index, post] of posts.entries()) {
  for (const person of people) {
    if (person.username === post.author) continue;
    if ((index + person.username.length) % 2 === 0) continue;
    statements.push(`INSERT OR IGNORE INTO reactions (id, user_id, target_type, target_id, reaction_type, created_at)
      VALUES (${q(newId('rct'))}, ${q(person.id)}, 'post', ${q(post.id)}, 'like', ${ts});`);
  }
}

for (const follower of people) {
  for (const target of people) {
    if (follower.id === target.id) continue;
    if ((follower.username.length + target.username.length) % 3 === 0) continue;
    statements.push(
      `INSERT OR IGNORE INTO follows (follower_id, following_id, created_at) VALUES (${q(follower.id)}, ${q(target.id)}, ${ts});`,
    );
  }
}

statements.push(
  `INSERT OR IGNORE INTO bookmarks (user_id, post_id, created_at) VALUES (${q(byUsername.get('lan').id)}, ${q(posts[1].id)}, ${ts});`,
  `INSERT OR IGNORE INTO bookmarks (user_id, post_id, created_at) VALUES (${q(byUsername.get('sora').id)}, ${q(posts[0].id)}, ${ts});`,
);

// --- Recompute every denormalised counter from the truth tables -----------
statements.push(`
UPDATE posts SET
  comment_count  = (SELECT COUNT(*) FROM comments c WHERE c.post_id = posts.id AND c.status = 'published'),
  reaction_count = (SELECT COUNT(*) FROM reactions r WHERE r.target_type = 'post' AND r.target_id = posts.id),
  bookmark_count = (SELECT COUNT(*) FROM bookmarks b WHERE b.post_id = posts.id);

UPDATE comments SET
  reply_count    = (SELECT COUNT(*) FROM comments r WHERE r.parent_id = comments.id AND r.status = 'published'),
  reaction_count = (SELECT COUNT(*) FROM reactions r WHERE r.target_type = 'comment' AND r.target_id = comments.id);

UPDATE tags SET post_count = (SELECT COUNT(*) FROM post_tags pt WHERE pt.tag_id = tags.id);

UPDATE categories SET post_count = (
  SELECT COUNT(*) FROM posts p WHERE p.category_id = categories.id AND p.status = 'published'
);

UPDATE users SET
  post_count      = (SELECT COUNT(*) FROM posts p WHERE p.author_id = users.id AND p.status = 'published'),
  comment_count   = (SELECT COUNT(*) FROM comments c WHERE c.author_id = users.id AND c.status = 'published'),
  follower_count  = (SELECT COUNT(*) FROM follows f WHERE f.following_id = users.id),
  following_count = (SELECT COUNT(*) FROM follows f WHERE f.follower_id = users.id),
  reaction_received_count = (
    SELECT COUNT(*) FROM reactions r
     WHERE (r.target_type = 'post'    AND r.target_id IN (SELECT id FROM posts    WHERE author_id = users.id))
        OR (r.target_type = 'comment' AND r.target_id IN (SELECT id FROM comments WHERE author_id = users.id))
  );

-- XP mirrors the server rules (post 10, comment 4, reaction received 2, follower 3).
UPDATE users SET xp = post_count * 10 + comment_count * 4 + reaction_received_count * 2 + follower_count * 3;
`);

execSql(target, statements.join('\n'));

console.log(`\n✅ Seeded ${people.length} members, ${posts.length} posts and ${comments.length} comments.`);
console.log(`   Sign in as any of: ${people.map((p) => `@${p.username}`).join(', ')}`);
console.log(`   Demo password: ${DEMO_PASSWORD}`);
console.log('   Change it (or reset the database) before exposing this deployment.');
