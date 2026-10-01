import { z } from 'zod';
import { isIP } from 'node:net';

const blockedAvatarHosts = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google',
  'metadata.google.internal',
  'metadata.azure.internal',
  'host.docker.internal',
  '168.63.129.16',
]);

function isBlockedAvatarHost(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.+$/, '');
  const ipVersion = isIP(host);

  if (
    blockedAvatarHosts.has(host) ||
    host.endsWith('.localhost') ||
    ipVersion === 6
  ) return true;
  if (ipVersion !== 4) return false;

  const [first, second] = host.split('.').map(Number);
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

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
  .refine((url) => {
    try {
      const parsedUrl = new URL(url);
      return parsedUrl.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Avatar URL must use HTTPS')
  .refine((url) => {
    try {
      return !isBlockedAvatarHost(new URL(url).hostname);
    } catch {
      return false;
    }
  }, 'Avatar URL must not target a private or internal host');

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
