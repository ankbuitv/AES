/** Polls, mutes, tag follows, collections, DMs, revisions, prefs. */

import { Db, placeholders } from '../client';
import { newId } from '../../utils/id';
import { now } from '../../utils/time';

export class ExtraRepository {
  constructor(private readonly db: Db) {}

  async setScheduled(postId: string, scheduledAt: number | null): Promise<void> {
    await this.db.run('UPDATE posts SET scheduled_at = ?, status = ?, updated_at = ? WHERE id = ?', [
      scheduledAt,
      scheduledAt ? 'draft' : 'published',
      now(),
      postId,
    ]);
  }

  async dueScheduled(limit = 25): Promise<{ id: string; author_id: string }[]> {
    return this.db.all(
      `SELECT id, author_id FROM posts
       WHERE scheduled_at IS NOT NULL AND scheduled_at <= ? AND status = 'draft'
       ORDER BY scheduled_at ASC LIMIT ?`,
      [now(), limit],
    );
  }

  async publishScheduled(postId: string): Promise<void> {
    await this.db.run(
      `UPDATE posts SET status = 'published', scheduled_at = NULL, updated_at = ? WHERE id = ?`,
      [now(), postId],
    );
  }

  async setQuote(postId: string, quotePostId: string | null): Promise<void> {
    await this.db.run('UPDATE posts SET quote_post_id = ? WHERE id = ?', [quotePostId, postId]);
  }

  async addRevision(input: {
    postId: string;
    title: string;
    content: string;
    editedBy: string;
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO post_revisions (id, post_id, title, content, edited_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId('rev'), input.postId, input.title, input.content, input.editedBy, now()],
    );
  }

  async listRevisions(postId: string) {
    return this.db.all<{
      id: string;
      title: string;
      content: string;
      edited_by: string | null;
      created_at: number;
    }>(
      `SELECT id, title, content, edited_by, created_at FROM post_revisions
       WHERE post_id = ? ORDER BY created_at DESC LIMIT 30`,
      [postId],
    );
  }

  async setPoll(postId: string, labels: string[]): Promise<void> {
    await this.db.run('DELETE FROM poll_options WHERE post_id = ?', [postId]);
    const ts = now();
    const statements = labels.slice(0, 8).map((label, index) => ({
      sql: `INSERT INTO poll_options (id, post_id, label, position, vote_count) VALUES (?, ?, ?, ?, 0)`,
      params: [newId('opt'), postId, label.slice(0, 80), index] as (string | number)[],
    }));
    if (statements.length) await this.db.batch(statements);
    void ts;
  }

  async pollForPosts(postIds: string[]) {
    const out = new Map<string, { id: string; label: string; voteCount: number }[]>();
    if (!postIds.length) return out;
    const rows = await this.db.all<{
      post_id: string;
      id: string;
      label: string;
      vote_count: number;
    }>(
      `SELECT post_id, id, label, vote_count FROM poll_options
       WHERE post_id IN (${placeholders(postIds.length)}) ORDER BY position ASC`,
      postIds,
    );
    for (const row of rows) {
      const list = out.get(row.post_id) ?? [];
      list.push({ id: row.id, label: row.label, voteCount: row.vote_count });
      out.set(row.post_id, list);
    }
    return out;
  }

  async viewerVotes(userId: string, postIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!userId || !postIds.length) return out;
    const rows = await this.db.all<{ post_id: string; option_id: string }>(
      `SELECT post_id, option_id FROM poll_votes
       WHERE user_id = ? AND post_id IN (${placeholders(postIds.length)})`,
      [userId, ...postIds],
    );
    for (const row of rows) out.set(row.post_id, row.option_id);
    return out;
  }

  async votePoll(input: { userId: string; postId: string; optionId: string }) {
    const existing = await this.db.first<{ option_id: string }>(
      'SELECT option_id FROM poll_votes WHERE user_id = ? AND post_id = ?',
      [input.userId, input.postId],
    );
    if (existing?.option_id === input.optionId) return;
    if (existing) {
      await this.db.batch([
        {
          sql: 'UPDATE poll_options SET vote_count = MAX(0, vote_count - 1) WHERE id = ?',
          params: [existing.option_id],
        },
        {
          sql: 'UPDATE poll_votes SET option_id = ?, created_at = ? WHERE user_id = ? AND post_id = ?',
          params: [input.optionId, now(), input.userId, input.postId],
        },
        {
          sql: 'UPDATE poll_options SET vote_count = vote_count + 1 WHERE id = ? AND post_id = ?',
          params: [input.optionId, input.postId],
        },
      ]);
      return;
    }
    await this.db.batch([
      {
        sql: 'INSERT INTO poll_votes (post_id, option_id, user_id, created_at) VALUES (?, ?, ?, ?)',
        params: [input.postId, input.optionId, input.userId, now()],
      },
      {
        sql: 'UPDATE poll_options SET vote_count = vote_count + 1 WHERE id = ? AND post_id = ?',
        params: [input.optionId, input.postId],
      },
    ]);
  }

  async listMutes(userId: string) {
    return this.db.all<{ kind: string; target_id: string; word: string }>(
      'SELECT kind, target_id, word FROM mutes WHERE user_id = ?',
      [userId],
    );
  }

  async addMute(userId: string, kind: 'user' | 'word', targetId: string, word: string) {
    await this.db.run(
      `INSERT OR IGNORE INTO mutes (user_id, kind, target_id, word, created_at) VALUES (?, ?, ?, ?, ?)`,
      [userId, kind, targetId, word.toLowerCase().slice(0, 40), now()],
    );
  }

  async removeMute(userId: string, kind: 'user' | 'word', targetId: string, word: string) {
    await this.db.run(
      'DELETE FROM mutes WHERE user_id = ? AND kind = ? AND target_id = ? AND word = ?',
      [userId, kind, targetId, word.toLowerCase()],
    );
  }

  async followTag(userId: string, tagId: string): Promise<boolean> {
    const existing = await this.db.first(
      'SELECT 1 AS x FROM tag_follows WHERE user_id = ? AND tag_id = ?',
      [userId, tagId],
    );
    if (existing) {
      await this.db.run('DELETE FROM tag_follows WHERE user_id = ? AND tag_id = ?', [userId, tagId]);
      return false;
    }
    await this.db.run('INSERT INTO tag_follows (user_id, tag_id, created_at) VALUES (?, ?, ?)', [
      userId,
      tagId,
      now(),
    ]);
    return true;
  }

  async isFollowingTag(userId: string, tagId: string): Promise<boolean> {
    return (
      (await this.db.first('SELECT 1 AS x FROM tag_follows WHERE user_id = ? AND tag_id = ?', [
        userId,
        tagId,
      ])) !== null
    );
  }

  async followedTagSlugs(userId: string): Promise<string[]> {
    const rows = await this.db.all<{ slug: string }>(
      `SELECT t.slug FROM tag_follows tf JOIN tags t ON t.id = tf.tag_id WHERE tf.user_id = ?`,
      [userId],
    );
    return rows.map((r) => r.slug);
  }

  async listCollections(userId: string) {
    return this.db.all<{ id: string; name: string }>(
      'SELECT id, name FROM bookmark_collections WHERE user_id = ? ORDER BY created_at DESC',
      [userId],
    );
  }

  async createCollection(userId: string, name: string): Promise<string> {
    const id = newId('col');
    await this.db.run(
      'INSERT INTO bookmark_collections (id, user_id, name, created_at) VALUES (?, ?, ?, ?)',
      [id, userId, name.slice(0, 60), now()],
    );
    return id;
  }

  async assignBookmarkCollection(userId: string, postId: string, collectionId: string | null) {
    await this.db.run(
      'UPDATE bookmarks SET collection_id = ? WHERE user_id = ? AND post_id = ?',
      [collectionId, userId, postId],
    );
  }

  async findOrCreateConversation(a: string, b: string): Promise<string> {
    const existing = await this.db.first<{ conversation_id: string }>(
      `SELECT m1.conversation_id FROM conversation_members m1
       JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id
       WHERE m1.user_id = ? AND m2.user_id = ?
       LIMIT 1`,
      [a, b],
    );
    if (existing) return existing.conversation_id;
    const id = newId('cnv');
    const ts = now();
    await this.db.batch([
      { sql: 'INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)', params: [id, ts, ts] },
      {
        sql: 'INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)',
        params: [id, a],
      },
      {
        sql: 'INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)',
        params: [id, b],
      },
    ]);
    return id;
  }

  async listConversations(userId: string) {
    return this.db.all<{
      id: string;
      updated_at: number;
      peer_username: string;
      peer_display_name: string;
      last_content: string | null;
    }>(
      `SELECT c.id, c.updated_at,
              u.username AS peer_username,
              u.display_name AS peer_display_name,
              (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_content
       FROM conversation_members me
       JOIN conversations c ON c.id = me.conversation_id
       JOIN conversation_members other ON other.conversation_id = c.id AND other.user_id <> ?
       JOIN users u ON u.id = other.user_id
       WHERE me.user_id = ?
       ORDER BY c.updated_at DESC LIMIT 40`,
      [userId, userId],
    );
  }

  async isMember(conversationId: string, userId: string): Promise<boolean> {
    return (
      (await this.db.first(
        'SELECT 1 AS x FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
        [conversationId, userId],
      )) !== null
    );
  }

  async listMessages(conversationId: string, limit = 50) {
    const rows = await this.db.all<{
      id: string;
      sender_id: string;
      content: string;
      created_at: number;
      username: string;
      display_name: string;
    }>(
      `SELECT m.id, m.sender_id, m.content, m.created_at, u.username, u.display_name
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = ?
       ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
      [conversationId, limit],
    );
    return rows.reverse();
  }

  async sendMessage(conversationId: string, senderId: string, content: string) {
    const id = newId('msg');
    const ts = now();
    await this.db.batch([
      {
        sql: 'INSERT INTO messages (id, conversation_id, sender_id, content, created_at) VALUES (?, ?, ?, ?, ?)',
        params: [id, conversationId, senderId, content, ts],
      },
      { sql: 'UPDATE conversations SET updated_at = ? WHERE id = ?', params: [ts, conversationId] },
    ]);
    return id;
  }

  async listReactors(targetType: string, targetId: string, limit = 40) {
    return this.db.all<{
      username: string;
      display_name: string;
      avatar_media_id: string | null;
      reaction_type: string;
    }>(
      `SELECT u.username, u.display_name, u.avatar_media_id, r.reaction_type
       FROM reactions r JOIN users u ON u.id = r.user_id
       WHERE r.target_type = ? AND r.target_id = ?
       ORDER BY r.created_at DESC LIMIT ?`,
      [targetType, targetId, limit],
    );
  }

  async relatedPostIds(postId: string, limit = 5): Promise<string[]> {
    const rows = await this.db.all<{ id: string }>(
      `SELECT p.id FROM posts p
       JOIN post_tags pt ON pt.post_id = p.id
       WHERE p.id <> ? AND p.status = 'published' AND p.visibility = 'public'
         AND pt.tag_id IN (SELECT tag_id FROM post_tags WHERE post_id = ?)
       GROUP BY p.id
       ORDER BY COUNT(*) DESC, p.created_at DESC
       LIMIT ?`,
      [postId, postId, limit],
    );
    return rows.map((r) => r.id);
  }

  async getPref(userId: string) {
    return this.db.first<{ email_digest: number; digest_last_at: number | null }>(
      'SELECT email_digest, digest_last_at FROM user_prefs WHERE user_id = ?',
      [userId],
    );
  }

  async setDigest(userId: string, enabled: boolean): Promise<void> {
    await this.db.run(
      `INSERT INTO user_prefs (user_id, email_digest) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET email_digest = excluded.email_digest`,
      [userId, enabled ? 1 : 0],
    );
  }

  async usersWantingDigest() {
    return this.db.all<{ user_id: string; digest_last_at: number | null }>(
      `SELECT u.id AS user_id, p.digest_last_at
       FROM users u
       LEFT JOIN user_prefs p ON p.user_id = u.id
       WHERE u.status = 'active' AND COALESCE(p.email_digest, 1) = 1
       LIMIT 200`,
    );
  }

  async markDigestSent(userId: string): Promise<void> {
    await this.db.run(
      `INSERT INTO user_prefs (user_id, email_digest, digest_last_at) VALUES (?, 1, ?)
       ON CONFLICT(user_id) DO UPDATE SET digest_last_at = excluded.digest_last_at`,
      [userId, now()],
    );
  }

  async recentPublicPostsSince(since: number, limit = 8) {
    return this.db.all<{ id: string; slug: string; title: string; excerpt: string }>(
      `SELECT id, slug, title, excerpt FROM posts
       WHERE status = 'published' AND visibility = 'public' AND created_at > ?
       ORDER BY created_at DESC LIMIT ?`,
      [since, limit],
    );
  }

  async savePush(userId: string, endpoint: string, keysJson: string): Promise<void> {
    await this.db.run(
      `INSERT OR REPLACE INTO push_subscriptions (id, user_id, endpoint, keys_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [newId('psh'), userId, endpoint.slice(0, 2000), keysJson.slice(0, 2000), now()],
    );
  }
}
