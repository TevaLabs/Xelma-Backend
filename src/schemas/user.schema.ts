import { z } from 'zod';

const nicknameSchema = z
  .string()
  .trim()
  .min(2, 'Nickname must be at least 2 characters')
  .max(30, 'Nickname must be at most 30 characters')
  .regex(/^[a-zA-Z0-9_.-]+$/, 'Nickname may only contain letters, digits, underscores, dots, or hyphens');

const avatarUrlSchema = z
  .string()
  .trim()
  .max(500, 'Avatar URL must be at most 500 characters')
  .url('Avatar URL must be a valid URL')
  .refine(
    (url) => url.startsWith('https://'),
    'Avatar URL must use HTTPS',
  );

const preferencesSchema = z
  .object({
    notifications: z.boolean().optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    language: z
      .string()
      .trim()
      .min(2)
      .max(10)
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Language must be a valid BCP 47 code (e.g. "en" or "en-US")')
      .optional(),
  })
  .strict()
  .optional();

export const updateProfileSchema = z
  .object({
    nickname: nicknameSchema.optional(),
    avatarUrl: avatarUrlSchema.optional(),
    preferences: preferencesSchema,
  })
  .strict()
  .refine(
    (data) => Object.keys(data).length > 0,
    'At least one field must be provided for update',
  );

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
