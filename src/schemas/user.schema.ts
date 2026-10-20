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

/**
 * Stored notification-preference document. Defaults match the Prisma
 * `User.notificationPreferences` column default.
 */
export const notificationPreferencesSchema = z.object({
  win: z.boolean().default(true),
  loss: z.boolean().default(true),
  roundStart: z.boolean().default(false),
  bonus: z.boolean().default(true),
  announcement: z.boolean().default(true),
});

export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

/** Partial update. Omitted keys are left unchanged by the route handler. */
export const updateNotificationPreferencesSchema = z.object({
  win: z.boolean().optional(),
  loss: z.boolean().optional(),
  roundStart: z.boolean().optional(),
  bonus: z.boolean().optional(),
  announcement: z.boolean().optional(),
}).strict().refine(
  (data) => Object.keys(data).length > 0,
  'At least one notification preference must be provided',
);

export type UpdateNotificationPreferencesInput = z.infer<typeof updateNotificationPreferencesSchema>;
