/**
 * Media repository — metadata only.
 *
 * D1 stores the pointer (`storage_key`) and the facts needed to serve and
 * authorise a byte range. The bytes themselves only ever live in the object
 * store behind `StorageProvider`.
 */

import { Db, placeholders } from '../client';
import type { MediaRow, MediaStatus, MediaUsage, MediaVariant, Visibility } from '../../types/models';
import { newId } from '../../utils/id';
import { now } from '../../utils/time';
import type { Cursor } from '../../utils/cursor';

export class MediaRepository {
  constructor(private readonly db: Db) {}

  async findById(id: string): Promise<MediaRow | null> {
    return this.db.first<MediaRow>('SELECT * FROM media WHERE id = ?', [id]);
  }

  async findManyByIds(ids: string[]): Promise<MediaRow[]> {
    if (!ids.length) return [];
    const unique = [...new Set(ids)];
    return this.db.all<MediaRow>(
      `SELECT * FROM media WHERE id IN (${placeholders(unique.length)})`,
      unique,
    );
  }

  /** Look up a derived variant (thumb/medium) of an original. */
  async findVariant(parentId: string, variant: MediaVariant): Promise<MediaRow | null> {
    if (variant === 'original') return this.findById(parentId);
    return this.db.first<MediaRow>(
      `SELECT * FROM media WHERE parent_id = ? AND variant = ? AND status <> 'deleted'`,
      [parentId, variant],
    );
  }

  /**
   * Dedupe: the same owner re-uploading identical bytes reuses the stored
   * object instead of paying for a second copy.
   */
  async findByChecksum(ownerId: string, checksum: string): Promise<MediaRow | null> {
    if (!checksum) return null;
    return this.db.first<MediaRow>(
      `SELECT * FROM media
       WHERE owner_id = ? AND checksum = ? AND variant = 'original' AND status = 'ready'
       LIMIT 1`,
      [ownerId, checksum],
    );
  }

  async findByStorageKey(storageKey: string): Promise<MediaRow | null> {
    return this.db.first<MediaRow>('SELECT * FROM media WHERE storage_key = ?', [storageKey]);
  }

  async create(input: {
    id?: string;
    ownerId: string;
    storageKey: string;
    storageProvider: string;
    originalName: string;
    mimeType: string;
    size: number;
    width: number | null;
    height: number | null;
    checksum: string;
    variant?: MediaVariant;
    parentId?: string | null;
    visibility?: Visibility;
    status?: MediaStatus;
    usageContext?: MediaUsage;
  }): Promise<MediaRow> {
    const id = input.id ?? newId('med');
    await this.db.run(
      `INSERT INTO media
         (id, owner_id, storage_key, storage_provider, original_name, mime_type, size,
          width, height, checksum, variant, parent_id, visibility, status, usage_context, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.ownerId,
        input.storageKey,
        input.storageProvider,
        input.originalName,
        input.mimeType,
        input.size,
        input.width,
        input.height,
        input.checksum,
        input.variant ?? 'original',
        input.parentId ?? null,
        input.visibility ?? 'public',
        input.status ?? 'ready',
        input.usageContext ?? 'attachment',
        now(),
      ],
    );
    const row = await this.findById(id);
    if (!row) throw new Error('Media insert did not persist');
    return row;
  }

  async setStatus(id: string, status: MediaStatus): Promise<void> {
    await this.db.run(
      `UPDATE media SET status = ?, deleted_at = CASE WHEN ? = 'deleted' THEN ? ELSE deleted_at END
       WHERE id = ?`,
      [status, status, now(), id],
    );
  }

  async setVisibility(id: string, visibility: Visibility): Promise<void> {
    await this.db.run('UPDATE media SET visibility = ? WHERE id = ?', [visibility, id]);
  }

  async attachToUsage(id: string, usage: MediaUsage): Promise<void> {
    await this.db.run('UPDATE media SET usage_context = ? WHERE id = ?', [usage, id]);
  }

  /**
   * Soft delete an original and its variants, and enqueue the object keys for
   * removal from the bucket. D1 and the bucket are separate systems, so the
   * queue is what keeps them eventually consistent.
   */
  async softDeleteWithVariants(id: string): Promise<string[]> {
    const rows = await this.db.all<MediaRow>(
      `SELECT * FROM media WHERE (id = ? OR parent_id = ?) AND status <> 'deleted'`,
      [id, id],
    );
    if (!rows.length) return [];

    const ts = now();
    const statements: { sql: string; params: (string | number | null)[] }[] = [
      {
        sql: `UPDATE media SET status = 'deleted', deleted_at = ? WHERE id = ? OR parent_id = ?`,
        params: [ts, id, id],
      },
    ];
    for (const row of rows) {
      statements.push({
        sql: `INSERT INTO storage_cleanup_queue (id, storage_key, provider, reason, created_at)
              VALUES (?, ?, ?, ?, ?)`,
        params: [newId('cln'), row.storage_key, row.storage_provider, 'media_deleted', ts],
      });
    }
    await this.db.batch(statements);
    return rows.map((row) => row.storage_key);
  }

  async listByOwner(options: {
    ownerId: string;
    cursor: Cursor | null;
    limit: number;
    usage?: MediaUsage;
  }): Promise<MediaRow[]> {
    const where = ['owner_id = ?', `status = 'ready'`, `variant = 'original'`];
    const params: (string | number)[] = [options.ownerId];
    if (options.usage) {
      where.push('usage_context = ?');
      params.push(options.usage);
    }
    if (options.cursor) {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(options.cursor.v, options.cursor.v, options.cursor.i);
    }
    return this.db.all<MediaRow>(
      `SELECT * FROM media WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      [...params, options.limit + 1],
    );
  }

  /** Bytes stored per owner — enforces a per-user quota. */
  async totalBytesForOwner(ownerId: string): Promise<number> {
    return (
      (await this.db.scalar<number>(
        `SELECT COALESCE(SUM(size), 0) FROM media WHERE owner_id = ? AND status IN ('ready', 'processing', 'pending')`,
        [ownerId],
      )) ?? 0
    );
  }

  async countUploadsSince(ownerId: string, since: number): Promise<number> {
    return (
      (await this.db.scalar<number>(
        'SELECT COUNT(*) FROM media WHERE owner_id = ? AND created_at > ?',
        [ownerId, since],
      )) ?? 0
    );
  }

  /**
   * Orphans: originals that were uploaded but never attached to a post,
   * avatar or cover within the grace period.
   */
  async findOrphans(olderThan: number, limit = 100): Promise<MediaRow[]> {
    return this.db.all<MediaRow>(
      `SELECT m.* FROM media m
       WHERE m.status IN ('ready', 'pending')
         AND m.variant = 'original'
         AND m.created_at < ?
         AND NOT EXISTS (SELECT 1 FROM post_media pm WHERE pm.media_id = m.id)
         AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_media_id = m.id OR u.cover_media_id = m.id)
       ORDER BY m.created_at ASC
       LIMIT ?`,
      [olderThan, limit],
    );
  }

  /** Rows to verify against the bucket (missing object → status `missing`). */
  async sampleForIntegrityCheck(limit = 50): Promise<MediaRow[]> {
    return this.db.all<MediaRow>(
      `SELECT * FROM media WHERE status = 'ready' ORDER BY RANDOM() LIMIT ?`,
      [limit],
    );
  }

  async markMissing(id: string): Promise<void> {
    await this.db.run(`UPDATE media SET status = 'missing' WHERE id = ?`, [id]);
  }

  // --- storage cleanup queue ------------------------------------------------

  async enqueueCleanup(storageKey: string, provider: string, reason: string): Promise<void> {
    await this.db.run(
      `INSERT INTO storage_cleanup_queue (id, storage_key, provider, reason, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [newId('cln'), storageKey, provider, reason, now()],
    );
  }

  async takeCleanupBatch(limit = 25) {
    return this.db.all<{
      id: string;
      storage_key: string;
      provider: string;
      attempts: number;
    }>(
      `SELECT id, storage_key, provider, attempts FROM storage_cleanup_queue
       WHERE processed_at IS NULL AND attempts < 5
       ORDER BY created_at ASC LIMIT ?`,
      [limit],
    );
  }

  async markCleanupDone(id: string): Promise<void> {
    await this.db.run('UPDATE storage_cleanup_queue SET processed_at = ? WHERE id = ?', [
      now(),
      id,
    ]);
  }

  async markCleanupFailed(id: string, error: string): Promise<void> {
    await this.db.run(
      'UPDATE storage_cleanup_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?',
      [error.slice(0, 300), id],
    );
  }

  async totalBytes(): Promise<number> {
    return (
      (await this.db.scalar<number>(
        `SELECT COALESCE(SUM(size), 0) FROM media WHERE status = 'ready'`,
      )) ?? 0
    );
  }
}
