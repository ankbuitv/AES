import { z } from 'zod';
import { idSchema } from './common';
import { LIMITS } from '../config';

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1, 'Display name is required').max(LIMITS.displayNameMax).optional(),
  bio: z.string().trim().max(LIMITS.bioMax).optional(),
  location: z.string().trim().max(80).optional(),
  website: z
    .string()
    .trim()
    .max(200)
    .refine((v) => !v || /^https?:\/\/\S+$/i.test(v), 'Website must start with http:// or https://')
    .optional(),
  avatarMediaId: idSchema.nullable().optional(),
  coverMediaId: idSchema.nullable().optional(),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1, 'Enter a search term').max(LIMITS.searchQueryMax),
  type: z.enum(['posts', 'users', 'tags', 'all']).optional().default('all'),
  cursor: z.string().max(256).optional(),
  limit: z.union([z.string(), z.number()]).optional(),
});

export const reportSchema = z.object({
  targetType: z.enum(['post', 'comment', 'user', 'media']),
  targetId: idSchema,
  reason: z.enum([
    'spam',
    'harassment',
    'hate',
    'nsfw',
    'violence',
    'misinformation',
    'copyright',
    'other',
  ]),
  description: z.string().trim().max(LIMITS.reportDescriptionMax).optional().default(''),
});

export const moderationActionSchema = z.object({
  action: z.enum([
    'hide_post',
    'restore_post',
    'delete_post',
    'hide_comment',
    'restore_comment',
    'delete_comment',
    'suspend_user',
    'unsuspend_user',
    'ban_user',
    'promote_moderator',
    'demote_moderator',
    'delete_media',
  ]),
  targetId: idSchema,
  reason: z.string().trim().max(500).optional().default(''),
  durationHours: z.number().int().min(1).max(24 * 365).optional(),
});

export const resolveReportSchema = z.object({
  status: z.enum(['reviewing', 'resolved', 'rejected']),
  resolution: z.string().trim().max(500).optional().default(''),
});

/**
 * Mark one or more notifications read.
 *
 * A form body (`ids=abc`) yields a bare string, while a repeated field
 * (`ids=abc&ids=def`) and a JSON body both yield an array — the body parser
 * deliberately preserves that distinction. Accepting either shape is what makes
 * "mark this one read" work from the dropdown, from the full page and from a
 * no-JavaScript form alike.
 */
export const notificationReadSchema = z.object({
  ids: z
    .union([idSchema, z.array(idSchema)])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .refine((ids) => ids.length >= 1 && ids.length <= 100, 'Pass between 1 and 100 ids'),
});
