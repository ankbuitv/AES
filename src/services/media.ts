/**
 * Media service — the only place that combines D1 metadata with the object
 * store. Routes never talk to `StorageProvider` directly.
 *
 * Upload pipeline:
 *   1. size gate (streaming-safe: the body is read once, capped);
 *   2. magic-byte sniff → the declared Content-Type is only ever a hint;
 *   3. dangerous-payload rejection (php/html/svg/exe/…);
 *   4. checksum dedupe per owner;
 *   5. PUT to storage under a server-generated key;
 *   6. INSERT metadata row.
 * If step 6 fails the object is enqueued for cleanup, so the bucket never keeps
 * an unreferenced blob.
 *
 * Serving: `GET /media/{id}` resolves permissions in D1, then streams the
 * object through the Worker. Bucket credentials and the bucket hostname never
 * reach the browser.
 */

import type { ServiceContext } from './context';
import { AppError } from '../utils/errors';
import { generateObjectKey } from './storage';
import {
  detectDangerous,
  extensionForMime,
  isAllowedImageMime,
  sanitizeFilename,
  sniffMime,
} from '../utils/mime';
import { sha256Hex } from '../utils/crypto';
import { buildPage, type Cursor } from '../utils/cursor';
import type { AuthUser, MediaDTO, MediaRow, MediaUsage, MediaVariant, Visibility } from '../types/models';
import { now } from '../utils/time';

/** Longest-lived cache for immutable media (content is addressed by id). */
const PUBLIC_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const PRIVATE_CACHE_CONTROL = 'private, no-store';

/** Per-user quota. Generous for a community site, bounded for cost control. */
const OWNER_QUOTA_BYTES = 512 * 1024 * 1024;
const UPLOADS_PER_HOUR = 60;

export interface UploadInput {
  owner: AuthUser;
  file: File | Blob;
  declaredType?: string;
  filename?: string;
  usage?: MediaUsage;
  visibility?: Visibility;
  altText?: string;
}

export class MediaService {
  constructor(private readonly ctx: ServiceContext) {}

  // --- Upload ---------------------------------------------------------------

  async upload(input: UploadInput): Promise<MediaDTO> {
    const { repos, config } = this.ctx;
    const usage: MediaUsage = input.usage ?? 'attachment';

    // 1. Size. `File.size` is authoritative for a parsed multipart part; the
    //    request-level cap in middleware protects against streaming abuse.
    const size = input.file.size;
    if (!size) throw AppError.badRequest('The uploaded file is empty');
    if (size > config.maxUploadBytes) {
      throw AppError.tooLarge(
        `File is larger than the ${Math.floor(config.maxUploadBytes / 1024 / 1024)} MB limit`,
      );
    }

    // Abuse limits before we spend money on a bucket write.
    const [used, recent] = await Promise.all([
      repos.media.totalBytesForOwner(input.owner.id),
      repos.media.countUploadsSince(input.owner.id, now() - 3600),
    ]);
    if (used + size > OWNER_QUOTA_BYTES) {
      throw AppError.tooLarge('You have reached your storage quota');
    }
    if (recent >= UPLOADS_PER_HOUR) {
      throw AppError.rateLimited(600, 'Too many uploads. Try again later.');
    }

    const buffer = await input.file.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // 2/3. Content-based classification. Order matters: reject hostile
    //      payloads before trying to interpret them as an image.
    const dangerous = detectDangerous(bytes);
    const sniffed = sniffMime(bytes);
    if (!sniffed) {
      throw AppError.unsupportedMedia(
        dangerous
          ? `Files of type "${dangerous}" are not allowed`
          : 'Only JPEG, PNG, WebP, GIF, MP4 and WebM can be uploaded',
      );
    }
    if (dangerous && dangerous !== 'markup') {
      throw AppError.unsupportedMedia(`Files of type "${dangerous}" are not allowed`);
    }
    if (!isAllowedImageMime(sniffed.mime, config.allowedUploadMime)) {
      throw AppError.unsupportedMedia(`${sniffed.mime} uploads are not enabled`);
    }

    // A declared type that disagrees with the bytes is a strong attack signal.
    const declared = (input.declaredType || '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (declared && declared !== 'application/octet-stream' && declared !== sniffed.mime) {
      throw AppError.unsupportedMedia('The file content does not match its declared type');
    }

    // 4. Dedupe identical bytes for the same owner.
    const checksum = await sha256Hex(bytes);
    const existing = await repos.media.findByChecksum(input.owner.id, checksum);
    if (existing) {
      if (usage !== existing.usage_context) await repos.media.attachToUsage(existing.id, usage);
      return toMediaDTO({ ...existing, usage_context: usage });
    }

    // 5. Upload under a key we generated. The client filename is metadata only.
    const mediaId = newMediaId();
    const key = generateObjectKey({
      usage: usage === 'avatar' || usage === 'cover' || usage === 'post' ? usage : 'attachment',
      ownerId: input.owner.id,
      mediaId,
      extension: extensionForMime(sniffed.mime),
    });

    const storage = this.ctx.storage();
    try {
      await storage.uploadObject({
        key,
        body: bytes,
        contentType: sniffed.mime,
        metadata: { owner: input.owner.id, media: mediaId },
      });
    } catch (error) {
      // A bucket outage is an upstream failure, not a bug in the request:
      // report it as 502 so clients can retry, and never echo the provider's
      // message (it can contain bucket names or signed URLs).
      this.ctx.logger.error('media_upload_failed', {
        mediaId,
        provider: storage.name,
        error: error instanceof Error ? error.message : 'unknown',
      });
      throw AppError.storage('The file could not be stored. Please try again.', error);
    }

    // 6. Persist metadata. On failure the object would be orphaned, so queue it.
    try {
      const row = await repos.media.create({
        id: mediaId,
        ownerId: input.owner.id,
        storageKey: key,
        storageProvider: storage.name,
        originalName: sanitizeFilename(input.filename ?? 'upload'),
        mimeType: sniffed.mime,
        size,
        width: sniffed.width ?? null,
        height: sniffed.height ?? null,
        checksum,
        variant: 'original',
        visibility: input.visibility ?? 'public',
        status: 'ready',
        usageContext: usage,
      });

      // Derived variants are produced out-of-band; see `generateVariants`.
      this.ctx.defer(this.ctx.repos.jobs.enqueue('media_variants', { mediaId: row.id }));

      return toMediaDTO(row);
    } catch (error) {
      this.ctx.defer(repos.media.enqueueCleanup(key, storage.name, 'metadata_insert_failed'));
      throw error;
    }
  }

  // --- Serving --------------------------------------------------------------

  /**
   * Resolve a media id + variant for reading, applying ownership/visibility
   * rules. Returns the row whose bytes should be streamed.
   */
  async resolveForRead(
    mediaId: string,
    variant: MediaVariant,
    viewer: { id: string; role: string } | null,
  ): Promise<MediaRow> {
    const original = await this.ctx.repos.media.findById(mediaId);
    if (!original || original.status === 'deleted') throw AppError.notFound('Media not found');
    if (original.status === 'missing') {
      throw AppError.notFound('This file is no longer available');
    }

    const isOwner = viewer?.id === original.owner_id;
    const isStaff = viewer?.role === 'admin' || viewer?.role === 'moderator';

    if (original.visibility === 'private' && !isOwner && !isStaff) {
      throw AppError.forbidden('This file is private');
    }
    if (original.visibility === 'followers' && !isOwner && !isStaff) {
      if (!viewer) throw AppError.unauthenticated('Sign in to view this file');
      const follows = await this.ctx.repos.users.isFollowing(viewer.id, original.owner_id);
      if (!follows) throw AppError.forbidden('Only followers can view this file');
    }

    if (variant === 'original') return original;

    // Fall back to the original when the derived variant does not exist yet —
    // correctness beats a 404 while the variant job is pending.
    const derived = await this.ctx.repos.media.findVariant(original.id, variant);
    return derived && derived.status === 'ready' ? derived : original;
  }

  /** Stream the object with correct caching, range and integrity headers. */
  async serve(row: MediaRow, request: Request): Promise<Response> {
    const storage = this.ctx.storage();
    const etag = `"${row.checksum.slice(0, 32) || row.id}"`;

    // Conditional request — the cheapest possible response.
    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, {
        status: 304,
        headers: this.mediaHeaders(row, etag),
      });
    }

    const range = request.headers.get('range') ?? undefined;
    let object;
    try {
      object = await storage.downloadObject(row.storage_key, range);
    } catch (error) {
      this.ctx.logger.error('media_download_failed', {
        mediaId: row.id,
        error: error instanceof Error ? error.message : 'unknown',
      });
      throw AppError.storage('The file could not be retrieved');
    }

    if (!object) {
      // D1 says it exists but the bucket disagrees: flag it for the cron and
      // stop serving 500s for a permanently broken object.
      this.ctx.defer(this.ctx.repos.media.markMissing(row.id));
      throw AppError.notFound('This file is no longer available');
    }

    const headers = this.mediaHeaders(row, etag);
    headers.set('Content-Type', object.contentType || row.mime_type);
    if (range && object.size < row.size) {
      headers.set('Content-Length', String(object.size));
      headers.set('Content-Range', contentRangeFor(range, row.size, object.size));
      return new Response(object.body, { status: 206, headers });
    }

    headers.set('Content-Length', String(object.size || row.size));
    return new Response(object.body, { status: 200, headers });
  }

  private mediaHeaders(row: MediaRow, etag: string): Headers {
    const headers = new Headers({
      ETag: etag,
      'Accept-Ranges': 'bytes',
      // Never let a browser or CDN reinterpret the bytes as something else.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': `inline; filename="${row.id}.${extensionForMime(row.mime_type)}"`,
      'Cache-Control': row.visibility === 'public' ? PUBLIC_CACHE_CONTROL : PRIVATE_CACHE_CONTROL,
    });
    if (row.visibility !== 'public') headers.set('Vary', 'Cookie');
    return headers;
  }

  // --- Variants -------------------------------------------------------------

  /**
   * Produce thumb/medium renditions.
   *
   * Cloudflare's Images binding is the only way to resize inside a Worker
   * (there is no canvas / sharp in the runtime). When the binding is absent —
   * the default on the Workers free plan — the original is registered as the
   * variant source, and `/media/{id}?v=thumb` transparently serves the
   * original. That keeps the API contract intact without shipping a fake
   * resizer. See the README "Known limitations" section.
   */
  async generateVariants(mediaId: string): Promise<MediaVariant[]> {
    const images = (this.ctx.env as unknown as { IMAGES?: ImagesBinding }).IMAGES;
    if (!images) return [];

    const original = await this.ctx.repos.media.findById(mediaId);
    if (!original || original.status !== 'ready' || original.variant !== 'original') return [];

    const storage = this.ctx.storage();
    const created: MediaVariant[] = [];

    for (const [variant, width] of [
      ['thumb', 320],
      ['medium', 1080],
    ] as const) {
      if (original.width && original.width <= width) continue;
      const existing = await this.ctx.repos.media.findVariant(original.id, variant);
      if (existing) continue;

      const source = await storage.downloadObject(original.storage_key);
      if (!source) break;

      try {
        const result = await images
          .input(source.body)
          .transform({ width, fit: 'scale-down' })
          .output({ format: 'image/webp' });

        const bytes = new Uint8Array(await new Response(result.image()).arrayBuffer());
        const variantId = newMediaId();
        const key = generateObjectKey({
          usage: original.usage_context === 'avatar' ? 'avatar' : 'attachment',
          ownerId: original.owner_id,
          mediaId: original.id,
          extension: 'webp',
          variant,
        });

        await storage.uploadObject({ key, body: bytes, contentType: 'image/webp' });
        await this.ctx.repos.media.create({
          id: variantId,
          ownerId: original.owner_id,
          storageKey: key,
          storageProvider: storage.name,
          originalName: original.original_name,
          mimeType: 'image/webp',
          size: bytes.byteLength,
          width,
          height: original.height && original.width
            ? Math.round((original.height * width) / original.width)
            : null,
          checksum: await sha256Hex(bytes),
          variant,
          parentId: original.id,
          visibility: original.visibility,
          status: 'ready',
          usageContext: original.usage_context,
        });
        created.push(variant);
      } catch (error) {
        this.ctx.logger.warn('variant_failed', {
          mediaId,
          variant,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
    return created;
  }

  // --- Management -----------------------------------------------------------

  async listForOwner(options: {
    ownerId: string;
    cursor: Cursor | null;
    limit: number;
    usage?: MediaUsage;
  }) {
    const rows = await this.ctx.repos.media.listByOwner(options);
    return buildPage(
      rows,
      options.limit,
      (row) => toMediaDTO(row),
      (row) => ({ v: row.created_at, i: row.id }),
    );
  }

  async remove(input: { viewer: AuthUser; mediaId: string }): Promise<void> {
    const row = await this.ctx.repos.media.findById(input.mediaId);
    if (!row || row.status === 'deleted') throw AppError.notFound('Media not found');

    const isStaff = input.viewer.role === 'admin' || input.viewer.role === 'moderator';
    if (row.owner_id !== input.viewer.id && !isStaff) {
      throw AppError.forbidden('You can only delete your own uploads');
    }

    await this.ctx.repos.media.softDeleteWithVariants(row.id);
    // Objects are removed by the cleanup cron, which drains the queue.
    this.ctx.defer(this.drainCleanupQueue(10));

    if (isStaff && row.owner_id !== input.viewer.id) {
      this.ctx.defer(
        this.ctx.repos.audit.log({
          actorId: input.viewer.id,
          action: 'media.delete',
          targetType: 'media',
          targetId: row.id,
          metadata: { ownerId: row.owner_id },
        }),
      );
    }
  }

  /** Set (or clear) a user's avatar/cover from an owned media id. */
  async setProfileImage(input: {
    viewer: AuthUser;
    mediaId: string | null;
    kind: 'avatar' | 'cover';
  }): Promise<void> {
    if (input.mediaId) {
      const row = await this.ctx.repos.media.findById(input.mediaId);
      if (!row || row.status !== 'ready') throw AppError.badRequest('Unknown image');
      if (row.owner_id !== input.viewer.id) throw AppError.forbidden('That image is not yours');
      if (row.variant !== 'original') throw AppError.badRequest('Use the original image');
      await this.ctx.repos.media.attachToUsage(row.id, input.kind);
      await this.ctx.repos.media.setVisibility(row.id, 'public');
    }
    await this.ctx.repos.users.updateProfile(
      input.viewer.id,
      input.kind === 'avatar'
        ? { avatarMediaId: input.mediaId }
        : { coverMediaId: input.mediaId },
    );
  }

  // --- Cron work ------------------------------------------------------------

  /** Delete objects whose metadata rows are already gone (D1 → bucket). */
  async drainCleanupQueue(limit = 25): Promise<{ deleted: number; failed: number }> {
    const batch = await this.ctx.repos.media.takeCleanupBatch(limit);
    let deleted = 0;
    let failed = 0;

    for (const item of batch) {
      try {
        await this.ctx.storage().deleteObject(item.storage_key);
        await this.ctx.repos.media.markCleanupDone(item.id);
        deleted++;
      } catch (error) {
        await this.ctx.repos.media.markCleanupFailed(
          item.id,
          error instanceof Error ? error.message : 'unknown',
        );
        failed++;
      }
    }
    return { deleted, failed };
  }

  /** Uploads never attached to anything (bucket → D1 orphans). */
  async collectOrphans(graceSeconds = 60 * 60 * 24, limit = 100): Promise<number> {
    const orphans = await this.ctx.repos.media.findOrphans(now() - graceSeconds, limit);
    for (const row of orphans) {
      if (row.usage_context === 'avatar' || row.usage_context === 'cover') continue;
      await this.ctx.repos.media.softDeleteWithVariants(row.id);
    }
    if (orphans.length) await this.drainCleanupQueue(Math.min(orphans.length * 2, 50));
    return orphans.length;
  }

  /**
   * Sampled integrity check in the other direction: a row that claims `ready`
   * but has no object behind it becomes `missing` instead of 500-ing forever.
   */
  async verifyIntegrity(sampleSize = 25): Promise<{ checked: number; missing: number }> {
    const sample = await this.ctx.repos.media.sampleForIntegrityCheck(sampleSize);
    const storage = this.ctx.storage();
    let missing = 0;

    for (const row of sample) {
      try {
        const exists = await storage.objectExists(row.storage_key);
        if (!exists) {
          await this.ctx.repos.media.markMissing(row.id);
          missing++;
        }
      } catch {
        // Transient storage errors must not mark healthy media as missing.
      }
    }
    return { checked: sample.length, missing };
  }
}

// --- helpers ----------------------------------------------------------------

export function toMediaDTO(row: MediaRow): MediaDTO {
  return {
    id: row.id,
    mimeType: row.mime_type,
    size: row.size,
    width: row.width,
    height: row.height,
    variant: row.variant,
    visibility: row.visibility,
    status: row.status,
    usageContext: row.usage_context,
    createdAt: row.created_at,
    url: `/media/${row.id}`,
    thumbUrl: `/media/${row.id}?v=thumb`,
  };
}

function newMediaId(): string {
  // Local import avoids a cycle with utils/id in test doubles.
  return `med_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** Build a `Content-Range` header for a satisfied range request. */
function contentRangeFor(range: string, totalSize: number, returned: number): string {
  const match = /bytes=(\d*)-(\d*)/.exec(range);
  const start = match?.[1] ? Number(match[1]) : Math.max(0, totalSize - returned);
  const end = match?.[2] ? Number(match[2]) : start + returned - 1;
  return `bytes ${start}-${Math.min(end, totalSize - 1)}/${totalSize}`;
}
