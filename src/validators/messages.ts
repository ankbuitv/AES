import { z } from 'zod';
import { idSchema, usernameParamSchema } from './common';
import { LIMITS } from '../config';

/** Start (or reuse) a 1:1 conversation with someone. */
export const startConversationSchema = z.object({
  username: usernameParamSchema,
  /** Optional first line, so "message this person" is a single round trip. */
  content: z.string().max(LIMITS.messageContentMax).optional(),
});

/**
 * Client-generated echo id. Sent back verbatim so the sender can replace its
 * optimistic bubble instead of rendering the message twice when the socket
 * push and the HTTP response race.
 */
const clientIdSchema = z.string().max(64).optional();

export const sendMessageSchema = z.object({
  content: z
    .string()
    .min(1, 'Write a message')
    .max(LIMITS.messageContentMax, `Message must be at most ${LIMITS.messageContentMax} characters`),
  clientId: clientIdSchema,
});

/**
 * An attachment bubble: a photo, a voice clip or a sticker.
 *
 * The caption may be empty — the attachment is the message. `mediaId` is
 * optional here because the usual request carries the *file itself* as a
 * multipart part and the id does not exist yet; the route requires one or the
 * other and re-checks that a supplied id belongs to the sender, so a guessed id
 * can never be attached to someone else's chat.
 */
export const sendAttachmentSchema = z
  .object({
    kind: z.enum(['image', 'audio', 'sticker']),
    content: z.string().max(LIMITS.messageContentMax).optional().default(''),
    mediaId: idSchema.optional(),
    /** Voice-clip length in ms, capped at five minutes. */
    durationMs: z
      .union([z.string(), z.number()])
      .optional()
      .transform((v) => {
        const n = Number(v ?? 0);
        return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 5 * 60 * 1000) : 0;
      }),
    clientId: clientIdSchema,
  })
  .refine((value) => value.kind !== 'sticker' || Boolean(value.content?.trim()), {
    message: 'Pick a sticker',
    path: ['content'],
  });

/** `?q=` on the inbox. Empty means "no filter", so it is deliberately lenient. */
export const inboxSearchSchema = z.object({
  q: z.string().max(60).optional().default(''),
});

export const conversationIdSchema = idSchema;
