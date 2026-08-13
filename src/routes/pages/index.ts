/**
 * Server-rendered HTML routes.
 *
 * Everything a visitor (or a crawler) can reach without JavaScript lives here.
 * Each handler loads data through the same services the JSON API uses — there
 * is no second, divergent data path — and hands already-escaped markup to
 * `renderPage`, which owns the document shell, the CSP nonce and the caching
 * posture.
 *
 * Authorisation is enforced here, on the server, before any markup is built.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../../types/env';
import { getConfig, resolveOrigin } from '../../config';
import { serviceContext } from '../../services/context';
import { PostService } from '../../services/posts';
import { UserService } from '../../services/users';
import { MediaService } from '../../services/media';
import { AuthService } from '../../services/auth';
import { NotificationService } from '../../services/notifications';
import { ModerationService } from '../../services/moderation';
import { getSearchProvider, parseSearchOffset } from '../../services/search';
import { requireAuth, requireGuest, requireStaff, requireUser } from '../../middleware/auth';
import { readLimit, rateLimit } from '../../middleware/rateLimit';
import { decodeCursor, parseLimit } from '../../utils/cursor';
import { AppError } from '../../utils/errors';
import { readTheme } from '../../utils/cookies';
import { toPlainText } from '../../utils/markdown';
import { toIso } from '../../utils/time';
import { renderPage, absoluteUrl } from '../../views/render';
import { composer, feedTabsFor, renderFeedPage } from '../../views/pages/feed';
import { renderPostPage, authorRail } from '../../views/pages/post';
import { renderProfilePage, renderPeoplePage, type ProfileTab } from '../../views/pages/profile';
import {
  renderForgotPasswordPage,
  renderLoginPage,
  renderRegisterPage,
  renderResetPasswordPage,
} from '../../views/pages/auth';
import { renderSettingsPage } from '../../views/pages/settings';
import { renderNotificationsPage } from '../../views/pages/notifications';
import { renderSearchPage, type SearchTab } from '../../views/pages/search';
import { renderComposePage } from '../../views/pages/compose';
import { renderAdminPage, type AdminTab } from '../../views/pages/admin';
import { defaultRail } from './rail';
import type { FeedSort } from '../../db/repositories/posts';
import type { LeaderRow } from '../../views/components/rail';

const pages = new Hono<AppContext>();

/** Read a `?cursor=` value that came from a no-JS "load more" link. */
function cursorOf(c: Context<AppContext>) {
  return decodeCursor(c.req.query('cursor'));
}

function limitOf(c: Context<AppContext>, fallback = 15) {
  return parseLimit(c.req.query('limit'), fallback);
}

async function categoryOptions(c: Context<AppContext>) {
  const rows = await serviceContext(c).repos.categories.list();
  return rows.map((row) => ({ slug: row.slug, name: row.name }));
}

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

interface FeedRouteConfig {
  sort: FeedSort;
  heading: string;
  subheading: string;
  path: string;
  navKey: string;
  tabKey: string;
  requiresAuth?: boolean;
  /** Seconds of shared-cache TTL for anonymous visitors. */
  cacheSeconds?: number;
}

const FEEDS: FeedRouteConfig[] = [
  {
    sort: 'foryou',
    heading: 'Your feed',
    subheading: 'A blend of what you follow and what the community is reading.',
    path: '/',
    navKey: 'home',
    tabKey: 'foryou',
    cacheSeconds: 30,
  },
  {
    sort: 'latest',
    heading: 'Explore',
    subheading: 'Everything published recently, newest first.',
    path: '/explore',
    navKey: 'explore',
    tabKey: 'latest',
    cacheSeconds: 30,
  },
  {
    sort: 'trending',
    heading: 'Trending',
    subheading: 'Ranked by reactions, replies and reads over the last few days.',
    path: '/trending',
    navKey: 'trending',
    tabKey: 'trending',
    cacheSeconds: 60,
  },
  {
    sort: 'following',
    heading: 'Following',
    subheading: 'Only the people you follow.',
    path: '/following',
    navKey: 'following',
    tabKey: 'following',
    requiresAuth: true,
  },
];

for (const feed of FEEDS) {
  const handler = async (c: Context<AppContext>) => {
    const viewer = c.get('user');
    if (feed.requiresAuth && !viewer) {
      return c.redirect(`/login?next=${encodeURIComponent(feed.path)}`, 302);
    }

    const ctx = serviceContext(c);
    const config = getConfig(c.env);

    const [page, categories, aside] = await Promise.all([
      new PostService(ctx).feed({
        sort: feed.sort,
        viewer,
        cursor: cursorOf(c),
        limit: limitOf(c),
      }),
      categoryOptions(c),
      defaultRail(c),
    ]);

    const body = renderFeedPage({
      heading: feed.heading,
      subheading: feed.subheading,
      page,
      baseHref: feed.path,
      loadMoreEndpoint: `/api/posts?sort=${feed.sort}`,
      activeTab: feed.tabKey,
      signedIn: !!viewer,
      ...(viewer ? { composer: composer(c.get('csrfToken') ?? null, categories) } : {}),
      emptyTitle: feed.sort === 'following' ? 'Your following feed is quiet' : 'Nothing here yet',
      emptyBody:
        feed.sort === 'following'
          ? 'Follow a few people and their posts will show up here.'
          : 'Be the first to publish something.',
      emptyCta: viewer
        ? { href: '/compose', label: 'Write a post' }
        : { href: '/register', label: 'Create an account' },
    });

    return renderPage(c, {
      meta: {
        title: feed.path === '/' ? '' : feed.heading,
        description: feed.subheading || config.siteDescription,
        canonical: absoluteUrl(c, feed.path),
        jsonLd: [
          {
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: config.siteName,
            url: resolveOrigin(c.env, c.req.raw),
            potentialAction: {
              '@type': 'SearchAction',
              target: `${resolveOrigin(c.env, c.req.raw)}/search?q={search_term_string}`,
              'query-input': 'required name=search_term_string',
            },
          },
        ],
      },
      body,
      aside,
      active: feed.navKey,
      ...(feed.cacheSeconds ? { cacheSeconds: feed.cacheSeconds } : {}),
    });
  };

  pages.get(feed.path, readLimit(), handler);
}

pages.get('/bookmarks', requireAuth(), readLimit(), async (c) => {
  const viewer = requireUser(c.get('user'));
  const ctx = serviceContext(c);

  const [page, aside] = await Promise.all([
    new PostService(ctx).bookmarks({ viewer, cursor: cursorOf(c), limit: limitOf(c) }),
    defaultRail(c),
  ]);

  return renderPage(c, {
    meta: { title: 'Bookmarks', description: 'Posts you saved for later.', noindex: true },
    body: renderFeedPage({
      heading: 'Bookmarks',
      subheading: 'Posts you saved for later. Only you can see this list.',
      page,
      baseHref: '/bookmarks',
      loadMoreEndpoint: '/api/posts/bookmarks',
      activeTab: 'bookmarks',
      showTabs: false,
      signedIn: true,
      emptyTitle: 'No bookmarks yet',
      emptyBody: 'Tap the bookmark button on any post to save it here.',
    }),
    aside,
    active: 'bookmarks',
  });
});

pages.get('/tag/:slug', readLimit(), async (c) => {
  const slug = (c.req.param('slug') || '').toLowerCase().slice(0, 50);
  const ctx = serviceContext(c);

  const [page, aside] = await Promise.all([
    new PostService(ctx).feed({
      sort: 'latest',
      viewer: c.get('user'),
      cursor: cursorOf(c),
      limit: limitOf(c),
      tagSlug: slug,
    }),
    defaultRail(c),
  ]);

  return renderPage(c, {
    meta: {
      title: `#${slug}`,
      description: `Posts tagged #${slug}.`,
      canonical: absoluteUrl(c, `/tag/${slug}`),
    },
    body: renderFeedPage({
      heading: `#${slug}`,
      subheading: 'Everything tagged with this hashtag.',
      page,
      baseHref: `/tag/${slug}`,
      loadMoreEndpoint: `/api/posts?sort=latest&tag=${encodeURIComponent(slug)}`,
      activeTab: '',
      showTabs: false,
      signedIn: !!c.get('user'),
      emptyTitle: 'No posts with this tag yet',
      emptyBody: 'Be the first to use it.',
    }),
    aside,
    active: 'explore',
    cacheSeconds: 60,
  });
});

pages.get('/category/:slug', readLimit(), async (c) => {
  const slug = (c.req.param('slug') || '').toLowerCase().slice(0, 120);
  const ctx = serviceContext(c);
  const category = await ctx.repos.categories.findBySlug(slug);
  if (!category) throw AppError.notFound('That category does not exist');

  const [page, aside] = await Promise.all([
    new PostService(ctx).feed({
      sort: 'latest',
      viewer: c.get('user'),
      cursor: cursorOf(c),
      limit: limitOf(c),
      categorySlug: slug,
    }),
    defaultRail(c),
  ]);

  return renderPage(c, {
    meta: {
      title: category.name,
      description: category.description || `Posts in ${category.name}.`,
      canonical: absoluteUrl(c, `/category/${slug}`),
    },
    body: renderFeedPage({
      heading: category.name,
      subheading: category.description || 'Everything filed under this category.',
      page,
      baseHref: `/category/${slug}`,
      loadMoreEndpoint: `/api/posts?sort=latest&category=${encodeURIComponent(slug)}`,
      activeTab: '',
      showTabs: false,
      signedIn: !!c.get('user'),
      emptyTitle: 'Nothing in this category yet',
      emptyBody: 'Posts filed here will show up on this page.',
    }),
    aside,
    active: 'explore',
    cacheSeconds: 60,
  });
});

// ---------------------------------------------------------------------------
// Single post
// ---------------------------------------------------------------------------

pages.get('/post/:slug', readLimit(), async (c) => {
  const slug = c.req.param('slug');
  const ctx = serviceContext(c);
  const viewer = c.get('user');
  const service = new PostService(ctx);

  const post = await service.viewBySlug(slug, viewer);

  // Views are counted once per (post, viewer key) and never block the render.
  const viewerKey = viewer ? `usr:${viewer.id}` : (c.get('clientKey') ?? 'anon');
  ctx.defer(service.recordView(post.id, viewerKey));

  const [thread, aside] = await Promise.all([
    service.commentThread({ postId: post.id, viewer, cursor: null, limit: 20 }),
    defaultRail(c),
  ]);

  const description = post.excerpt || toPlainText(post.title, 160) || 'A post on AnkSocial';
  const heroImage = post.media[0]
    ? absoluteUrl(c, `/media/${post.media[0].id}?v=medium`)
    : undefined;

  return renderPage(c, {
    meta: {
      title: post.title || `Post by @${post.author.username}`,
      description,
      canonical: absoluteUrl(c, `/post/${post.slug}`),
      ogType: 'article',
      ...(heroImage ? { image: heroImage } : {}),
      noindex: post.visibility !== 'public' || post.status !== 'published',
      publishedTime: post.createdAt,
      authorName: post.author.displayName || post.author.username,
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': post.contentType === 'article' ? 'Article' : 'SocialMediaPosting',
          headline: post.title || description.slice(0, 110),
          datePublished: toIso(post.createdAt),
          dateModified: toIso(post.editedAt ?? post.updatedAt),
          author: {
            '@type': 'Person',
            name: post.author.displayName || post.author.username,
            url: absoluteUrl(c, `/u/${post.author.username}`),
          },
          interactionStatistic: [
            {
              '@type': 'InteractionCounter',
              interactionType: 'https://schema.org/LikeAction',
              userInteractionCount: post.reactionCount,
            },
            {
              '@type': 'InteractionCounter',
              interactionType: 'https://schema.org/CommentAction',
              userInteractionCount: post.commentCount,
            },
          ],
        },
      ],
    },
    body: renderPostPage({
      post,
      comments: thread.items,
      commentsCursor: thread.nextCursor,
      commentTotal: post.commentCount,
      canReply: !!viewer,
      csrfToken: c.get('csrfToken') ?? null,
    }),
    aside: `${authorRail(post)}\n${aside}`,
    bootstrap: { postId: post.id, postSlug: post.slug },
    ...(post.visibility === 'public' && post.status === 'published' ? { cacheSeconds: 60 } : {}),
  });
});

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

async function profileHandler(c: Context<AppContext>, tab: ProfileTab) {
  const username = (c.req.param('username') || '').toLowerCase();
  const ctx = serviceContext(c);
  const viewer = c.get('user');

  const profile = await new UserService(ctx).profile(username, viewer);
  const posts = new PostService(ctx);

  const [data, aside] = await Promise.all([
    tab === 'replies'
      ? posts.commentsByAuthor({
          authorId: profile.id,
          viewer,
          cursor: cursorOf(c),
          limit: limitOf(c),
        })
      : posts.byAuthor({
          authorId: profile.id,
          viewer,
          cursor: cursorOf(c),
          limit: limitOf(c),
          ...(tab === 'media' ? { mediaOnly: true } : {}),
        }),
    defaultRail(c),
  ]);

  const title =
    tab === 'media'
      ? `Media from @${profile.username}`
      : tab === 'replies'
        ? `Replies by @${profile.username}`
        : `${profile.displayName || profile.username} (@${profile.username})`;

  const path = tab === 'posts' ? `/u/${profile.username}` : `/u/${profile.username}/${tab}`;

  return renderPage(c, {
    meta: {
      title,
      description: profile.bio || `${profile.displayName || profile.username} on AnkSocial.`,
      canonical: absoluteUrl(c, path),
      ogType: 'profile',
      ...(profile.avatarMediaId
        ? { image: absoluteUrl(c, `/media/${profile.avatarMediaId}`) }
        : {}),
      noindex: profile.status !== 'active',
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'ProfilePage',
          mainEntity: {
            '@type': 'Person',
            name: profile.displayName || profile.username,
            alternateName: `@${profile.username}`,
            description: profile.bio || undefined,
            url: absoluteUrl(c, `/u/${profile.username}`),
          },
        },
      ],
    },
    body: renderProfilePage({
      profile,
      tab,
      csrfToken: c.get('csrfToken') ?? null,
      signedIn: !!viewer,
      ...(tab === 'replies'
        ? { replies: data as Awaited<ReturnType<PostService['commentsByAuthor']>> }
        : { posts: data as Awaited<ReturnType<PostService['byAuthor']>> }),
    }),
    aside,
    bootstrap: { profileUsername: profile.username },
    ...(profile.status === 'active' && !viewer ? { cacheSeconds: 60 } : {}),
  });
}

pages.get('/u/:username', readLimit(), (c) => profileHandler(c, 'posts'));
pages.get('/u/:username/media', readLimit(), (c) => profileHandler(c, 'media'));
pages.get('/u/:username/replies', readLimit(), (c) => profileHandler(c, 'replies'));

for (const relation of ['followers', 'following'] as const) {
  pages.get(`/u/:username/${relation}`, readLimit(), async (c) => {
    const username = (c.req.param('username') || '').toLowerCase();
    const service = new UserService(serviceContext(c));
    const page =
      relation === 'followers'
        ? await service.followers(username, cursorOf(c), limitOf(c, 30))
        : await service.following(username, cursorOf(c), limitOf(c, 30));

    const aside = await defaultRail(c);

    return renderPage(c, {
      meta: {
        title: relation === 'followers' ? `@${username}'s followers` : `People @${username} follows`,
        canonical: absoluteUrl(c, `/u/${username}/${relation}`),
        noindex: true,
      },
      body: renderPeoplePage({
        title: relation === 'followers' ? 'Followers' : 'Following',
        username,
        people: page.items.map((person) => ({
          id: person.id,
          username: person.username,
          displayName: person.displayName,
          avatarMediaId: person.avatarMediaId,
          level: person.level,
          bio: person.bio,
        })),
        nextCursor: page.nextCursor,
        baseHref: `/u/${username}/${relation}`,
      }),
      aside,
    });
  });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

pages.get('/search', rateLimit('search'), async (c) => {
  const rawQuery = (c.req.query('q') ?? '').trim().slice(0, 100);
  const typeParam = c.req.query('type');
  const tab: SearchTab =
    typeParam === 'posts' || typeParam === 'users' || typeParam === 'tags' ? typeParam : 'all';

  const ctx = serviceContext(c);
  const viewer = c.get('user');
  const aside = await defaultRail(c);

  if (!rawQuery) {
    return renderPage(c, {
      meta: { title: 'Search', description: 'Find posts, people and hashtags.', noindex: true },
      body: renderSearchPage({
        query: '',
        tab,
        posts: [],
        users: [],
        tags: [],
        nextCursor: null,
        hasMore: false,
      }),
      aside,
    });
  }

  const provider = getSearchProvider(ctx.repos.db, ctx.repos);
  const results = await provider.search({
    query: rawQuery,
    type: tab,
    viewerId: viewer?.id ?? null,
    limit: limitOf(c),
    offset: parseSearchOffset(c.req.query('cursor')),
  });

  const postService = new PostService(ctx);
  const posts = await Promise.all(
    results.posts.map((hit) => postService.toDTO(hit.post, { viewer })),
  );

  return renderPage(c, {
    meta: {
      title: `Search: ${rawQuery}`,
      description: `Results for “${rawQuery}”.`,
      // Search result pages are thin content; keep them out of the index.
      noindex: true,
    },
    body: renderSearchPage({
      query: results.query,
      tab,
      posts,
      users: results.users,
      tags: results.tags.map((t) => ({ slug: t.slug, name: t.name, postCount: t.post_count })),
      nextCursor: results.nextCursor,
      hasMore: results.hasMore,
    }),
    aside,
  });
});

// ---------------------------------------------------------------------------
// Authenticated surfaces
// ---------------------------------------------------------------------------

pages.get('/notifications', requireAuth(), async (c) => {
  const viewer = requireUser(c.get('user'));
  const unreadOnly = c.req.query('filter') === 'unread';
  const service = new NotificationService(serviceContext(c));

  const [page, unreadCount] = await Promise.all([
    service.list({
      userId: viewer.id,
      cursor: cursorOf(c),
      limit: limitOf(c, 25),
      ...(unreadOnly ? { unreadOnly: true } : {}),
    }),
    service.unreadCount(viewer.id),
  ]);

  return renderPage(c, {
    meta: { title: 'Notifications', noindex: true },
    body: renderNotificationsPage({
      page,
      unreadCount,
      unreadOnly,
      csrfToken: c.get('csrfToken') ?? null,
    }),
    bootstrap: { unreadCount },
  });
});

pages.get('/settings', requireAuth(), async (c) => {
  const viewer = requireUser(c.get('user'));
  const ctx = serviceContext(c);

  const [profile, sessions, media] = await Promise.all([
    new UserService(ctx).profile(viewer.username, viewer),
    new AuthService(ctx).listSessions(viewer.id, c.get('sessionId') ?? null),
    new MediaService(ctx).listForOwner({ ownerId: viewer.id, cursor: null, limit: 12 }),
  ]);

  return renderPage(c, {
    meta: { title: 'Settings', noindex: true },
    body: renderSettingsPage({
      user: viewer,
      profile,
      sessions,
      media: media.items,
      csrfToken: c.get('csrfToken') ?? null,
      theme: readTheme(c.req.raw),
    }),
  });
});

pages.get('/compose', requireAuth(), async (c) => {
  const categories = await categoryOptions(c);
  return renderPage(c, {
    meta: { title: 'New post', noindex: true },
    body: renderComposePage({ csrfToken: c.get('csrfToken') ?? null, categories }),
  });
});

// ---------------------------------------------------------------------------
// Auth pages (guests only)
// ---------------------------------------------------------------------------

/** Only ever redirect to a local path — never to an attacker-supplied origin. */
function safeNext(value: string | undefined): string {
  if (!value) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value.slice(0, 512);
}

pages.get('/login', requireGuest(), async (c) => {
  const config = getConfig(c.env);
  return renderPage(c, {
    meta: {
      title: 'Sign in',
      description: `Sign in to ${config.siteName}.`,
      canonical: absoluteUrl(c, '/login'),
    },
    body: renderLoginPage({
      csrfToken: c.get('csrfToken') ?? null,
      next: safeNext(c.req.query('next')),
      siteName: config.siteName,
      ...(c.req.query('registered') ? { notice: 'Account created. Sign in to continue.' } : {}),
    }),
  });
});

pages.get('/register', requireGuest(), async (c) => {
  const config = getConfig(c.env);
  return renderPage(c, {
    meta: {
      title: 'Create an account',
      description: `Join ${config.siteName}.`,
      canonical: absoluteUrl(c, '/register'),
    },
    body: renderRegisterPage({
      csrfToken: c.get('csrfToken') ?? null,
      next: safeNext(c.req.query('next')),
      siteName: config.siteName,
      registrationOpen: config.registrationOpen,
    }),
  });
});

pages.get('/forgot-password', requireGuest(), async (c) =>
  renderPage(c, {
    meta: { title: 'Reset your password', noindex: true },
    body: renderForgotPasswordPage({ csrfToken: c.get('csrfToken') ?? null }),
  }),
);

pages.get('/reset-password', requireGuest(), async (c) =>
  renderPage(c, {
    meta: { title: 'Choose a new password', noindex: true },
    body: renderResetPasswordPage({
      csrfToken: c.get('csrfToken') ?? null,
      token: (c.req.query('token') ?? '').slice(0, 128),
    }),
  }),
);

// ---------------------------------------------------------------------------
// Moderation dashboard
// ---------------------------------------------------------------------------

pages.get('/admin', requireAuth(), requireStaff(), async (c) => {
  const viewer = requireUser(c.get('user'));
  const tabParam = c.req.query('tab');
  const tab: AdminTab =
    tabParam === 'reports' || tabParam === 'users' || tabParam === 'posts' || tabParam === 'audit'
      ? tabParam
      : 'overview';

  const service = new ModerationService(serviceContext(c));
  const dashboard = await service.dashboard(viewer);

  const cursor = cursorOf(c);
  const limit = limitOf(c, 25);

  const reports =
    tab === 'reports'
      ? await service.listReports({ viewer, cursor, limit, status: 'open' })
      : { items: [], nextCursor: null, hasMore: false };

  const users =
    tab === 'users'
      ? await service.listUsers({
          viewer,
          cursor,
          limit,
          ...(c.req.query('status') ? { status: c.req.query('status') as string } : {}),
          ...(c.req.query('q') ? { query: c.req.query('q') as string } : {}),
        })
      : { items: [], nextCursor: null, hasMore: false };

  const posts =
    tab === 'posts'
      ? await service.listPosts({ viewer, cursor, limit })
      : { items: [], nextCursor: null, hasMore: false };

  const audit =
    tab === 'audit' && viewer.role === 'admin'
      ? await service.auditLog({ viewer, cursor, limit })
      : { items: [], nextCursor: null, hasMore: false };

  return renderPage(c, {
    meta: { title: 'Moderation', noindex: true },
    body: renderAdminPage({
      viewer,
      tab,
      csrfToken: c.get('csrfToken') ?? null,
      stats: dashboard.stats,
      days: dashboard.days,
      reports: reports.items,
      users: users.items,
      posts: posts.items,
      audit: audit.items,
      nextCursor: reports.nextCursor ?? users.nextCursor ?? posts.nextCursor ?? audit.nextCursor,
      baseHref: `/admin?tab=${tab}`,
    }),
    active: 'admin',
  });
});

// ---------------------------------------------------------------------------
// Small static-ish pages
// ---------------------------------------------------------------------------

pages.get('/leaderboard', readLimit(), async (c) => {
  const rows = (await new UserService(serviceContext(c)).leaderboard(50)) as LeaderRow[];
  const aside = await defaultRail(c);

  const body = `
    <div class="pagehead">
      <h1 class="pagehead__title">Top contributors</h1>
      <p class="pagehead__sub muted">XP is awarded by the server for posting, replying and receiving reactions.</p>
    </div>
    <ol class="peoplelist peoplelist--ranked">
      ${rows
        .map(
          (row, index) => `
        <li class="peoplelist__item">
          <span class="rank" aria-hidden="true">${index + 1}</span>
          <div>
            <a class="peoplelist__name" href="/u/${encodeURIComponent(row.username)}">${escapeText(
              row.display_name || row.username,
            )}</a>
            <p class="muted">Level ${row.level} · ${row.xp} XP</p>
          </div>
        </li>`,
        )
        .join('')}
    </ol>`;

  return renderPage(c, {
    meta: {
      title: 'Leaderboard',
      description: 'The most active members, ranked by experience points.',
      canonical: absoluteUrl(c, '/leaderboard'),
    },
    body,
    aside,
    cacheSeconds: 300,
  });
});

/** Local escape helper for the tiny inline templates above. */
function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default pages;
