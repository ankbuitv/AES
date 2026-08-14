import { z } from 'zod';
import { httpUrlSchema, idSchema } from './common';
import { REEL_LIMITS } from '../services/reels';

/**
 * Import a reel from a link. Only the URL shape is validated here; whether it
 * belongs to a supported platform is decided by `parseReelUrl`, which is the
 * one place that knows how to build an embed.
 */
export const importReelSchema = z.object({
  url: httpUrlSchema,
  title: z.string().max(REEL_LIMITS.titleMax).optional(),
  caption: z.string().max(REEL_LIMITS.captionMax).optional(),
});

/** Publish a reel from a video already in the member's own media library. */
export const uploadReelSchema = z.object({
  mediaId: idSchema,
  title: z.string().max(REEL_LIMITS.titleMax).optional(),
  caption: z.string().max(REEL_LIMITS.captionMax).optional(),
});

export const reelSortSchema = z.enum(['latest', 'popular']).optional().default('latest');
