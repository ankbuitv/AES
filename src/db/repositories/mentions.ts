/**
 * @mentions.
 *
 * Mentions are extracted server-side from the post/comment source by
 * `extractMentions()` — never supplied by the client — then resolved against
 * real usernames so a mention of a non-existent user notifies nobody.
 */

import { Db, placeholders } from '../client';
import { newId } from '../../utils/id';
import { now } from '../../utils/time';

export type MentionSource = 'post' | 'comment';

export class MentionRepository {
  constructor(private readonly db: Db) {}

  /**
   * Resolve usernames to ids, skipping the author (self-mentions never
   * notify) and anyone who has blocked them.
   */
  async resolveUsernames(
    usernames: string[],
    authorId: string,
  ): Promise<{ id: string; username: string }[]> {
    const unique = [...new Set(usernames.map((u) => u.toLowerCase()))].slice(0, 20);
    if (!unique.length) return [];

    return this.db.all<{ id: string; username: string }>(
      `SELECT id, username FROM users
       WHERE username IN (${placeholders(unique.length)})
         AND status = 'active'
         AND id <> ?
         AND NOT EXISTS (
           SELECT 1 FROM blocks b
           WHERE (b.blocker_id = users.id AND b.blocked_id = ?)
              OR (b.blocker_id = ? AND b.blocked_id = users.id)
         )`,
      [...unique, authorId, authorId, authorId],
    );
  }

  /** Replace the mention set for a source (handles edits). */
  async replaceForSource(
    sourceType: MentionSource,
    sourceId: string,
    mentionedIds: string[],
  ): Promise<void> {
    const ts = now();
    const statements: { sql: string; params: (string | number)[] }[] = [
      {
        sql: 'DELETE FROM mentions WHERE source_type = ? AND source_id = ?',
        params: [sourceType, sourceId],
      },
    ];
    for (const mentionedId of [...new Set(mentionedIds)]) {
      statements.push({
        sql: `INSERT OR IGNORE INTO mentions (id, source_type, source_id, mentioned_id, created_at)
              VALUES (?, ?, ?, ?, ?)`,
        params: [newId('mnt'), sourceType, sourceId, mentionedId, ts],
      });
    }
    await this.db.batch(statements);
  }

  async listForSource(sourceType: MentionSource, sourceId: string): Promise<string[]> {
    const rows = await this.db.all<{ mentioned_id: string }>(
      'SELECT mentioned_id FROM mentions WHERE source_type = ? AND source_id = ?',
      [sourceType, sourceId],
    );
    return rows.map((r) => r.mentioned_id);
  }
}
