/**
 * Reel service — the rules of short-form video.
 *
 * Two ways to publish:
 *
 *  1. **Import** a link from YouTube Shorts, TikTok, Instagram or Facebook. The
 *     video keeps living on that platform and is played through its official
 *     embed; we store only the id we parsed out of the URL. Nothing is copied,
 *     scraped or re-hosted, which is what keeps the feature inside each
 *     network's terms of use.
 *  2. **Upload** an MP4/WebM to our own bucket through the existing media
 *     pipeline (same sniffing, quota and rate limits as any other upload).
 *
 * The embed URL is always *rebuilt* from a validated id — a client-supplied
 * string never reaches an `<iframe src>`.
 */

import type { ServiceContext } from './context';
import type { ReelDTO } from '../types/models';
import type { ReelRow, ReelSort } from '../db/repositories/reels';
import { AppError } from '../utils/errors';
import { buildPage, type Cursor } from '../utils/cursor';
import { normalizeText } from '../validators/common';
import { parseReelUrl, posterFor, PROVIDER_LABELS, type ReelProvider } from './reelSources';

export const REEL_LIMITS = {
  titleMax: 120,
  captionMax: 600,
} as const;

export class ReelService {
  constructor(private readonly ctx: ServiceContext) {}

  /** Import a third-party short video by URL. */
  async importFromUrl(input: {
    authorId: string;
    url: string;
    title?: string;
    caption?: string;
  }): Promise<ReelDTO> {
    const parsed = parseReelUrl(input.url);
    if (!parsed) {
      throw AppError.badRequest(
        'Paste a full YouTube Shorts, TikTok, Instagram or Facebook video link. Short share links (vm.tiktok.com, fb.watch) need to be opened once so they expand first.',
      );
    }

    // Importing the same video twice would give the feed duplicates; return the
    // existing reel instead of failing, so a double submit is harmless.
    const existing = await this.ctx.repos.reels.findByExternal(parsed.provider, parsed.externalId);
    if (existing) return toReelDTO(existing, input.authorId);

    const id = await this.ctx.repos.reels.create({
      authorId: input.authorId,
      provider: parsed.provider,
      externalId: parsed.externalId,
      sourceUrl: parsed.sourceUrl,
      embedUrl: parsed.embedUrl,
      mediaId: null,
      posterUrl: posterFor(parsed.provider, parsed.externalId),
      title: clamp(input.title, REEL_LIMITS.titleMax),
      caption: clamp(input.caption, REEL_LIMITS.captionMax),
    });

    const row = await this.ctx.repos.reels.findById(id, input.authorId);
    if (!row) throw new AppError('INTERNAL_ERROR', 'Reel could not be stored');
    return toReelDTO(row, input.authorId);
  }

  /** Publish a reel backed by a video already uploaded to our own storage. */
  async createFromUpload(input: {
    authorId: string;
    mediaId: string;
    title?: string;
    caption?: string;
  }): Promise<ReelDTO> {
    const media = await this.ctx.repos.media.findById(input.mediaId);
    if (!media || media.owner_id !== input.authorId) {
      throw AppError.badRequest('Upload the video first, then publish it as a reel');
    }
    if (!media.mime_type.startsWith('video/')) {
      throw AppError.badRequest('A reel needs a video file (MP4 or WebM)');
    }

    const id = await this.ctx.repos.reels.create({
      authorId: input.authorId,
      provider: 'upload',
      externalId: '',
      sourceUrl: '',
      embedUrl: '',
      mediaId: media.id,
      posterUrl: '',
      title: clamp(input.title, REEL_LIMITS.titleMax),
      caption: clamp(input.caption, REEL_LIMITS.captionMax),
    });

    const row = await this.ctx.repos.reels.findById(id, input.authorId);
    if (!row) throw new AppError('INTERNAL_ERROR', 'Reel could not be stored');
    return toReelDTO(row, input.authorId);
  }

  async feed(options: {
    sort?: ReelSort;
    viewerId: string | null;
    authorId?: string | null;
    provider?: ReelProvider | null;
    cursor: Cursor | null;
    limit: number;
  }) {
    const sort: ReelSort = options.sort ?? 'latest';
    const rows = await this.ctx.repos.reels.list({
      sort,
      viewerId: options.viewerId,
      authorId: options.authorId ?? null,
      provider: options.provider ?? null,
      cursor: options.cursor,
      limit: options.limit,
    });
    return buildPage(
      rows,
      options.limit,
      (row) => toReelDTO(row, options.viewerId),
      (row) => ({ v: sort === 'popular' ? row.like_count : row.created_at, i: row.id }),
    );
  }

  async get(id: string, viewerId: string | null): Promise<ReelDTO> {
    const row = await this.ctx.repos.reels.findById(id, viewerId);
    if (!row) throw AppError.notFound('That reel does not exist');
    return toReelDTO(row, viewerId);
  }

  /** Toggle a like and return the authoritative new state. */
  async toggleLike(reelId: string, userId: string): Promise<{ liked: boolean; likeCount: number }> {
    const row = await this.ctx.repos.reels.findById(reelId, userId);
    if (!row) throw AppError.notFound('That reel does not exist');

    const liked = await this.ctx.repos.reels.hasLiked(reelId, userId);
    const likeCount = liked
      ? await this.ctx.repos.reels.unlike(reelId, userId)
      : await this.ctx.repos.reels.like(reelId, userId);

    return { liked: !liked, likeCount };
  }

  /** Views are fire-and-forget: never block playback on a counter write. */
  countView(reelId: string): void {
    this.ctx.defer(this.ctx.repos.reels.incrementViews(reelId).catch(() => undefined));
  }

  async remove(reelId: string, viewer: { id: string; role: string }): Promise<void> {
    const row = await this.ctx.repos.reels.findById(reelId, viewer.id);
    if (!row) throw AppError.notFound('That reel does not exist');
    const staff = viewer.role === 'admin' || viewer.role === 'moderator';
    if (row.author_id !== viewer.id && !staff) {
      throw AppError.forbidden('Only the author can delete this reel');
    }
    await this.ctx.repos.reels.softDelete(reelId);
  }
}

function clamp(value: string | undefined, max: number): string {
  return normalizeText(value ?? '').slice(0, max);
}

export function toReelDTO(row: ReelRow, viewerId: string | null): ReelDTO {
  const isUpload = row.provider === 'upload';
  return {
    id: row.id,
    provider: row.provider,
    providerLabel: PROVIDER_LABELS[row.provider] ?? row.provider,
    externalId: row.external_id,
    sourceUrl: row.source_url,
    embedUrl: row.embed_url,
    // Self-hosted video is streamed through the Worker gateway, exactly like
    // images — the bucket is never addressed by the browser.
    videoUrl: isUpload && row.media_id ? `/media/${encodeURIComponent(row.media_id)}` : '',
    posterUrl: row.poster_url,
    title: row.title,
    caption: row.caption,
    viewCount: row.view_count,
    likeCount: row.like_count,
    commentCount: row.comment_count,
    createdAt: row.created_at,
    viewerLiked: Boolean(row.viewer_liked),
    canDelete: viewerId !== null && row.author_id === viewerId,
    author: {
      id: row.author_id,
      username: row.username,
      displayName: row.display_name || row.username,
      avatarMediaId: row.avatar_media_id,
      level: row.level,
    },
  };
}
