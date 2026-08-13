/**
 * Posts, comments, reactions, bookmarks, follows, notifications and search —
 * plus the permission boundaries around each (wrong user, wrong role, deleted
 * content, private visibility).
 */

import { describe, expect, it } from 'vitest';
import { TestClient } from './helpers/client';

interface PostPayload {
  post: {
    id: string;
    slug: string;
    html: string;
    title: string;
    tags: { slug: string }[];
    visibility: string;
    canEdit: boolean;
    canDelete: boolean;
  };
}

interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

async function withAuthor(username = 'author') {
  const client = new TestClient();
  await client.register({ username });
  return client;
}

describe('posts', () => {
  it('creates, reads and lists a markdown post', async () => {
    const client = await withAuthor();

    const created = await client.post<PostPayload>('/api/posts', {
      title: 'Hello world',
      content: 'This is **bold** and this is a #hashtag.',
      contentType: 'markdown',
      tags: 'intro, meta',
    });

    expect(created.status).toBe(201);
    const post = created.body.data!.post;
    expect(post.slug).toMatch(/^hello-world-/);
    expect(post.html).toContain('<strong>bold</strong>');
    expect(post.tags.map((t) => t.slug).sort()).toEqual(['hashtag', 'intro', 'meta']);

    const single = await client.get<PostPayload>(`/api/posts/${post.slug}`);
    expect(single.status).toBe(200);
    expect(single.body.data!.post.title).toBe('Hello world');

    const feed = await client.get<Page<{ id: string }>>('/api/posts?sort=latest');
    expect(feed.status).toBe(200);
    expect(feed.body.data!.items.some((item) => item.id === post.id)).toBe(true);
    expect(feed.body.data).toHaveProperty('nextCursor');
    expect(feed.body.data).toHaveProperty('hasMore');
  });

  it('shows another member public posts on the latest feed', async () => {
    const alice = await withAuthor('alicefeed');
    const post = (
      await alice.post<PostPayload>('/api/posts', { content: 'hello from alice, everyone should see this' })
    ).body.data!.post;

    const bob = new TestClient();
    Object.assign(bob, { env: alice.env });
    await bob.register({ username: 'bobfeed' });

    const asBob = await bob.get<Page<{ id: string; author?: { username: string } }>>(
      '/api/posts?sort=latest',
    );
    expect(asBob.status).toBe(200);
    expect(asBob.body.data!.items.some((item) => item.id === post.id)).toBe(true);

    const asGuest = new TestClient();
    Object.assign(asGuest, { env: alice.env });
    const guestFeed = await asGuest.get<Page<{ id: string }>>('/api/posts?sort=latest');
    expect(guestFeed.status).toBe(200);
    expect(guestFeed.body.data!.items.some((item) => item.id === post.id)).toBe(true);
  });

  it('requires authentication to publish', async () => {
    const client = new TestClient();
    await client.get('/login', { headers: { accept: 'text/html' } });

    const result = await client.post('/api/posts', { content: 'anonymous post' });
    expect(result.status).toBe(401);
  });

  it('rejects empty and oversized content', async () => {
    const client = await withAuthor('limits');

    expect((await client.post('/api/posts', { content: '' })).status).toBe(400);
    expect((await client.post('/api/posts', { content: 'x'.repeat(40_001) })).status).toBe(400);
  });

  it('requires a title for an article', async () => {
    const client = await withAuthor('articler');
    const result = await client.post('/api/posts', {
      content: 'Long form content goes here.',
      contentType: 'article',
    });
    expect(result.status).toBe(400);
  });

  it('lets the author edit and delete, and refuses everyone else', async () => {
    const owner = await withAuthor('owner');
    const created = await owner.post<PostPayload>('/api/posts', { content: 'mine' });
    const post = created.body.data!.post;
    expect(post.canEdit).toBe(true);

    const stranger = new TestClient();
    Object.assign(stranger, { env: owner.env });
    await stranger.register({ username: 'stranger' });

    const edit = await stranger.patch(`/api/posts/${post.id}`, { content: 'not mine' });
    expect(edit.status).toBe(403);

    const remove = await stranger.delete(`/api/posts/${post.id}`);
    expect(remove.status).toBe(403);

    const ownerEdit = await owner.patch<PostPayload>(`/api/posts/${post.id}`, {
      content: 'edited by me',
    });
    expect(ownerEdit.status).toBe(200);

    const ownerDelete = await owner.delete(`/api/posts/${post.id}`);
    expect(ownerDelete.status).toBeLessThan(400);

    const gone = await owner.get(`/api/posts/${post.id}`);
    expect(gone.status).toBe(404);
  });

  it('hides a private post from other members but not its author', async () => {
    const owner = await withAuthor('secretive');
    const created = await owner.post<PostPayload>('/api/posts', {
      content: 'for my eyes only',
      visibility: 'private',
    });
    const post = created.body.data!.post;

    const stranger = new TestClient();
    Object.assign(stranger, { env: owner.env });
    await stranger.register({ username: 'nosy' });

    expect((await stranger.get(`/api/posts/${post.slug}`)).status).toBe(403);
    expect((await owner.get(`/api/posts/${post.slug}`)).status).toBe(200);

    const feed = await stranger.get<Page<{ id: string }>>('/api/posts?sort=latest');
    expect(feed.body.data!.items.some((item) => item.id === post.id)).toBe(false);
  });

  it('shows a followers-only post to a follower and hides it otherwise', async () => {
    const owner = await withAuthor('gated');
    const created = await owner.post<PostPayload>('/api/posts', {
      content: 'followers only',
      visibility: 'followers',
    });
    const post = created.body.data!.post;

    const fan = new TestClient();
    Object.assign(fan, { env: owner.env });
    await fan.register({ username: 'fan' });

    expect((await fan.get(`/api/posts/${post.slug}`)).status).toBe(403);

    const follow = await fan.post('/api/users/gated/follow');
    expect(follow.status).toBeLessThan(400);

    expect((await fan.get(`/api/posts/${post.slug}`)).status).toBe(200);
  });

  it('paginates with a cursor and never repeats an item', async () => {
    const client = await withAuthor('prolific');
    for (let i = 0; i < 8; i++) {
      await client.post('/api/posts', { content: `post number ${i}` });
    }

    const first = await client.get<Page<{ id: string }>>('/api/posts?sort=latest&limit=3');
    expect(first.body.data!.items).toHaveLength(3);
    expect(first.body.data!.hasMore).toBe(true);

    const second = await client.get<Page<{ id: string }>>(
      `/api/posts?sort=latest&limit=3&cursor=${encodeURIComponent(first.body.data!.nextCursor!)}`,
    );
    expect(second.body.data!.items).toHaveLength(3);

    const firstIds = new Set(first.body.data!.items.map((i) => i.id));
    expect(second.body.data!.items.some((i) => firstIds.has(i.id))).toBe(false);
  });

  it('lets the author pin a post so it appears first in the latest feed', async () => {
    const client = await withAuthor('pinner');
    const older = (await client.post<PostPayload>('/api/posts', { content: 'older post' })).body
      .data!.post;
    const newer = (await client.post<PostPayload>('/api/posts', { content: 'newer post' })).body
      .data!.post;

    const pinned = await client.post<{ pinned: boolean }>(`/api/posts/${older.id}/pin`);
    expect(pinned.status).toBe(200);
    expect(pinned.body.data!.pinned).toBe(true);

    const feed = await client.get<Page<{ id: string; pinned?: boolean }>>('/api/posts?sort=latest');
    expect(feed.body.data!.items[0]?.id).toBe(older.id);
    expect(feed.body.data!.items[0]?.pinned).toBe(true);
    expect(feed.body.data!.items.some((item) => item.id === newer.id)).toBe(true);

    const stranger = new TestClient();
    Object.assign(stranger, { env: client.env });
    await stranger.register({ username: 'unpinme' });
    expect((await stranger.post(`/api/posts/${older.id}/pin`)).status).toBe(403);
  });
});

describe('comments', () => {
  it('creates a thread, nests replies and enforces the depth cap', async () => {
    const client = await withAuthor('threader');
    const post = (await client.post<PostPayload>('/api/posts', { content: 'discuss' })).body.data!
      .post;

    const root = await client.post<{ comment: { id: string; depth: number } }>(
      `/api/posts/${post.id}/comments`,
      { content: 'first!' },
    );
    expect(root.status).toBe(201);
    expect(root.body.data!.comment.depth).toBe(0);

    let parentId = root.body.data!.comment.id;
    const depths: number[] = [];
    for (let i = 0; i < 6; i++) {
      const reply = await client.post<{ comment: { id: string; depth: number } }>(
        `/api/posts/${post.id}/comments`,
        { content: `reply ${i}`, parentId },
      );
      if (reply.status >= 400) {
        // The cap is enforced by rejecting a reply that would exceed it.
        expect(reply.status).toBe(400);
        break;
      }
      depths.push(reply.body.data!.comment.depth);
      parentId = reply.body.data!.comment.id;
    }

    expect(Math.max(...depths)).toBeLessThanOrEqual(4);

    const thread = await client.get<Page<{ id: string; replies?: unknown[] }>>(
      `/api/posts/${post.id}/comments`,
    );
    expect(thread.status).toBe(200);
    expect(thread.body.data!.items.length).toBeGreaterThan(0);
  });

  it('refuses an empty comment and one on a missing post', async () => {
    const client = await withAuthor('commenter');
    const post = (await client.post<PostPayload>('/api/posts', { content: 'x' })).body.data!.post;

    expect((await client.post(`/api/posts/${post.id}/comments`, { content: '' })).status).toBe(400);
    expect(
      (await client.post('/api/posts/pst_nope000000000/comments', { content: 'hi' })).status,
    ).toBe(404);
  });

  it('only lets the author or a moderator delete a comment', async () => {
    const author = await withAuthor('cmtowner');
    const post = (await author.post<PostPayload>('/api/posts', { content: 'thread' })).body.data!
      .post;
    const comment = (
      await author.post<{ comment: { id: string } }>(`/api/posts/${post.id}/comments`, {
        content: 'mine',
      })
    ).body.data!.comment;

    const other = new TestClient();
    Object.assign(other, { env: author.env });
    await other.register({ username: 'randomer' });

    expect((await other.delete(`/api/comments/${comment.id}`)).status).toBe(403);

    // A moderator may remove it.
    other.promote('randomer', 'moderator');
    await other.post('/api/auth/logout');
    await other.login('randomer');
    expect((await other.delete(`/api/comments/${comment.id}`)).status).toBeLessThan(400);
  });
});

describe('reactions and bookmarks', () => {
  it('toggles a reaction and keeps the count consistent', async () => {
    const author = await withAuthor('reacted');
    const post = (await author.post<PostPayload>('/api/posts', { content: 'react to me' })).body
      .data!.post;

    const reader = new TestClient();
    Object.assign(reader, { env: author.env });
    await reader.register({ username: 'reader' });

    const on = await reader.post<{ reaction: string | null; count: number }>(
      `/api/posts/${post.id}/reactions`,
      { reaction: 'like' },
    );
    expect(on.status).toBe(200);
    expect(on.body.data!.count).toBe(1);

    const changed = await reader.post<{ reaction: string | null; count: number }>(
      `/api/posts/${post.id}/reactions`,
      { reaction: 'love' },
    );
    expect(changed.body.data!.reaction).toBe('love');
    expect(changed.body.data!.count).toBe(1);

    const off = await reader.post<{ reaction: string | null; count: number }>(
      `/api/posts/${post.id}/reactions`,
      { reaction: 'love' },
    );
    expect(off.body.data!.reaction).toBeNull();
    expect(off.body.data!.count).toBe(0);
  });

  it('rejects an unknown reaction type', async () => {
    const client = await withAuthor('badreact');
    const post = (await client.post<PostPayload>('/api/posts', { content: 'x' })).body.data!.post;
    const result = await client.post(`/api/posts/${post.id}/reactions`, { reaction: 'thermonuclear' });
    expect(result.status).toBe(400);
  });

  it('bookmarks a post and lists it privately', async () => {
    const author = await withAuthor('bmauthor');
    const post = (await author.post<PostPayload>('/api/posts', { content: 'save me' })).body.data!
      .post;

    const saver = new TestClient();
    Object.assign(saver, { env: author.env });
    await saver.register({ username: 'saver' });

    const saved = await saver.post<{ bookmarked: boolean }>(`/api/posts/${post.id}/bookmark`);
    expect(saved.body.data!.bookmarked).toBe(true);

    const list = await saver.get<Page<{ id: string }>>('/api/posts/bookmarks');
    expect(list.body.data!.items.map((i) => i.id)).toContain(post.id);
    expect(list.headers.get('cache-control')).toContain('no-store');

    const authorList = await author.get<Page<{ id: string }>>('/api/posts/bookmarks');
    expect(authorList.body.data!.items).toHaveLength(0);
  });
});

describe('follows and blocks', () => {
  it('follows, updates counters and unfollows', async () => {
    const a = await withAuthor('alpha');
    const b = new TestClient();
    Object.assign(b, { env: a.env });
    await b.register({ username: 'beta' });

    const follow = await b.post('/api/users/alpha/follow');
    expect(follow.status).toBeLessThan(400);

    const profile = await b.get<{ user: { followerCount: number; isFollowing: boolean } }>(
      '/api/users/alpha',
    );
    expect(profile.body.data!.user.followerCount).toBe(1);
    expect(profile.body.data!.user.isFollowing).toBe(true);

    const unfollow = await b.delete('/api/users/alpha/follow');
    expect(unfollow.status).toBeLessThan(400);

    const after = await b.get<{ user: { followerCount: number } }>('/api/users/alpha');
    expect(after.body.data!.user.followerCount).toBe(0);
  });

  it('refuses to follow yourself', async () => {
    const client = await withAuthor('narcissus');
    const result = await client.post('/api/users/narcissus/follow');
    expect(result.status).toBe(400);
  });

  it('returns 404 for an unknown profile', async () => {
    const client = new TestClient();
    expect((await client.get('/api/users/nobodyhere')).status).toBe(404);
  });
});

describe('notifications', () => {
  it('notifies the author when someone comments, and never for their own action', async () => {
    const author = await withAuthor('notified');
    const post = (await author.post<PostPayload>('/api/posts', { content: 'ping me' })).body.data!
      .post;

    await author.post(`/api/posts/${post.id}/comments`, { content: 'self reply' });

    const commenter = new TestClient();
    Object.assign(commenter, { env: author.env });
    await commenter.register({ username: 'pinger' });
    await commenter.post(`/api/posts/${post.id}/comments`, { content: 'nice post' });

    const list = await author.get<Page<{ type: string }>>('/api/notifications');
    expect(list.status).toBe(200);
    const types = list.body.data!.items.map((n) => n.type);
    expect(types).toContain('COMMENT');
    expect(types.filter((t) => t === 'COMMENT')).toHaveLength(1);

    const count = await author.get<{ count: number }>('/api/notifications/unread-count');
    expect(count.body.data!.count).toBeGreaterThan(0);

    const readAll = await author.post('/api/notifications/read-all');
    expect(readAll.status).toBeLessThan(400);

    const after = await author.get<{ count: number }>('/api/notifications/unread-count');
    expect(after.body.data!.count).toBe(0);
  });

  it('keeps notifications private to their owner', async () => {
    const client = new TestClient();
    expect((await client.get('/api/notifications')).status).toBe(401);
  });
});

describe('search', () => {
  it('finds a post by full-text match and a user by handle', async () => {
    const client = await withAuthor('searchable');
    await client.post('/api/posts', {
      title: 'Cursor pagination explained',
      content: 'Keyset pagination beats OFFSET for large feeds.',
      contentType: 'markdown',
    });

    const posts = await client.get<{ posts: { title: string }[] }>(
      '/api/search?q=pagination&type=posts',
    );
    expect(posts.status).toBe(200);
    expect(posts.body.data!.posts.length).toBeGreaterThan(0);

    const users = await client.get<{ users: { username: string }[] }>(
      '/api/search?q=searchable&type=users',
    );
    expect(users.body.data!.users.map((u) => u.username)).toContain('searchable');
  });

  it('requires a query and bounds its length', async () => {
    const client = new TestClient();
    expect((await client.get('/api/search')).status).toBe(400);
    expect((await client.get(`/api/search?q=${'x'.repeat(200)}`)).status).toBe(400);
  });

  it('does not leak private posts into results', async () => {
    const owner = await withAuthor('hidden');
    await owner.post('/api/posts', {
      title: 'Zzyzx secret document',
      content: 'Zzyzx should not be searchable by others.',
      visibility: 'private',
    });

    const stranger = new TestClient();
    Object.assign(stranger, { env: owner.env });
    const result = await stranger.get<{ posts: unknown[] }>('/api/search?q=Zzyzx&type=posts');
    expect(result.body.data!.posts).toHaveLength(0);
  });
});

describe('gamification', () => {
  it('awards XP server-side and ignores any client-supplied value', async () => {
    const client = await withAuthor('leveler');

    const before = await client.get<{ user: { xp: number } }>('/api/auth/me');
    const startXp = before.body.data!.user.xp;

    await client.post('/api/posts', { content: 'earning xp', xp: '999999', level: '99' });

    const after = await client.get<{ user: { xp: number; level: number } }>('/api/auth/me');
    expect(after.body.data!.user.xp).toBeGreaterThan(startXp);
    expect(after.body.data!.user.xp).toBeLessThan(1000);
    expect(after.body.data!.user.level).toBeLessThan(10);
  });
});
