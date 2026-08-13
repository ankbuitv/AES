import { z } from 'zod';
import { httpUrlSchema, idSchema, visibilitySchema } from './common';
import { LIMITS } from '../config';

export const postContentTypeSchema = z.enum([
  'text',
  'markdown',
  'article',
  'image',
  'link',
  'code',
]);

const tagNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[\p{L}\p{N}_]+$/u, 'Tags may only contain letters, numbers and underscores');

/**
 * Tags arrive either as a repeated form field / JSON array, or as one
 * comma-separated string typed into the composer input. Both are normalised
 * here so the no-JavaScript form submits exactly like the fetch client.
 */
const tagsSchema = z
  .preprocess((value) => {
    if (typeof value === 'string') {
      return value
        .split(/[,#\s]+/u)
        .map((part) => part.trim())
        .filter(Boolean);
    }
    return value;
  }, z.array(tagNameSchema).max(LIMITS.tagsPerPost))
  .optional();

/** Accepts a repeated field, a JSON array, or a single id string. */
const mediaIdsSchema = z
  .preprocess(
    (value) => (typeof value === 'string' ? value.split(',').map((v) => v.trim()).filter(Boolean) : value),
    z.array(idSchema).max(LIMITS.mediaPerPost),
  )
  .optional();

/** Categories are addressed by slug so the client never needs internal ids. */
const categorySlugSchema = z
  .string()
  .trim()
  .max(120)
  .regex(/^[a-z0-9-]*$/, 'Invalid category')
  .optional()
  .nullable();

export const createPostSchema = z
  .object({
    title: z.string().trim().max(LIMITS.postTitleMax).optional().default(''),
    content: z.string().min(1, 'Write something first').max(LIMITS.postContentMax),
    contentType: postContentTypeSchema.default('text'),
    visibility: visibilitySchema.default('public'),
    status: z.enum(['published', 'draft']).default('published'),
    category: categorySlugSchema,
    tags: tagsSchema,
    mediaIds: mediaIdsSchema,
    linkUrl: httpUrlSchema.optional().or(z.literal('')),
    codeLanguage: z
      .string()
      .trim()
      .max(20)
      .regex(/^[a-zA-Z0-9+#._-]*$/, 'Invalid language')
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.contentType === 'article' && !value.title.trim()) {
      ctx.addIssue({ code: 'custom', path: ['title'], message: 'Articles need a title' });
    }
    if (value.contentType === 'link' && !value.linkUrl) {
      ctx.addIssue({ code: 'custom', path: ['linkUrl'], message: 'Link posts need a URL' });
    }
    if (value.contentType === 'image' && !(value.mediaIds && value.mediaIds.length)) {
      ctx.addIssue({ code: 'custom', path: ['mediaIds'], message: 'Image posts need an image' });
    }
  });

export const updatePostSchema = z.object({
  title: z.string().trim().max(LIMITS.postTitleMax).optional(),
  content: z.string().min(1).max(LIMITS.postContentMax).optional(),
  visibility: visibilitySchema.optional(),
  status: z.enum(['published', 'draft']).optional(),
  category: categorySlugSchema,
  tags: tagsSchema,
  mediaIds: mediaIdsSchema,
  linkUrl: httpUrlSchema.optional().or(z.literal('')),
  codeLanguage: z.string().trim().max(20).optional(),
});

export const feedQuerySchema = z.object({
  cursor: z.string().max(256).optional(),
  limit: z.union([z.string(), z.number()]).optional(),
  sort: z.enum(['latest', 'trending', 'foryou', 'following']).optional().default('latest'),
  category: z.string().max(120).optional(),
  tag: z.string().max(50).optional(),
  author: z.string().max(24).optional(),
});

export const createCommentSchema = z.object({
  content: z.string().trim().min(1, 'Write a comment first').max(LIMITS.commentContentMax),
  parentId: idSchema.optional().nullable(),
});

export const updateCommentSchema = z.object({
  content: z.string().trim().min(1).max(LIMITS.commentContentMax),
});

export type CreatePostInput = z.infer<typeof createPostSchema>;
export type UpdatePostInput = z.infer<typeof updatePostSchema>;
