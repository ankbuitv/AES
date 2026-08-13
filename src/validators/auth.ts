import { z } from 'zod';
import { emailSchema, passwordSchema, usernameSchema } from './common';
import { LIMITS } from '../config';

export const registerSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(LIMITS.displayNameMax)
    .optional(),
});

export const loginSchema = z.object({
  // Accepts either a username or an email address.
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(LIMITS.passwordMax),
  remember: z.union([z.boolean(), z.string()]).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(LIMITS.passwordMax),
  newPassword: passwordSchema,
});

export const requestPasswordResetSchema = z.object({
  email: emailSchema,
});

export const confirmPasswordResetSchema = z.object({
  token: z.string().min(20).max(200),
  newPassword: passwordSchema,
});

export const deleteAccountSchema = z.object({
  password: z.string().min(1).max(LIMITS.passwordMax),
  confirm: z.literal('DELETE'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
