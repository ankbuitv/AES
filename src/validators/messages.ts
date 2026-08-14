import { z } from 'zod';
import { idSchema, usernameParamSchema } from './common';
import { LIMITS } from '../config';

/** Start (or reuse) a 1:1 conversation with someone. */
export const startConversationSchema = z.object({
  username: usernameParamSchema,
  /** Optional first line, so "message this person" is a single round trip. */
  content: z.string().max(LIMITS.messageContentMax).optional(),
});

export const sendMessageSchema = z.object({
  content: z
    .string()
    .min(1, 'Write a message')
    .max(LIMITS.messageContentMax, `Message must be at most ${LIMITS.messageContentMax} characters`),
  /**
   * Client-generated echo id. Sent back verbatim so the sender can replace its
   * optimistic bubble instead of rendering the message twice when the socket
   * push and the HTTP response race.
   */
  clientId: z.string().max(64).optional(),
});

export const conversationIdSchema = idSchema;
