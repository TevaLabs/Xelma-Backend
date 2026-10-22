import { z } from 'zod';
import { NotificationType } from '@prisma/client';
import { NotificationDataValidationError, ErrorDetail } from '../utils/errors';

export const winNotificationDataSchema = z
  .object({
    roundId: z.string().min(1, 'roundId is required'),
    amount: z.number().nonnegative('amount must be non-negative'),
    predictionId: z.string().optional(),
    txHash: z.string().optional(),
  })
  .strip();

export const lossNotificationDataSchema = z
  .object({
    roundId: z.string().min(1, 'roundId is required'),
    amount: z.number().nonnegative('amount must be non-negative').optional(),
    predictionId: z.string().optional(),
  })
  .strip();

export const roundStartNotificationDataSchema = z
  .object({
    roundId: z.string().min(1, 'roundId is required'),
    startPrice: z.number().optional(),
  })
  .strip();

export const bonusAvailableNotificationDataSchema = z
  .object({
    amount: z.number().nonnegative('amount must be non-negative'),
    bonusType: z.string().optional(),
    expiresAt: z.string().optional(),
    streak: z.number().int().nonnegative().optional(),
  })
  .strip();

export const announcementNotificationDataSchema = z.union([
  z.null(),
  z.undefined(),
  z
    .object({
      link: z.string().optional(),
      action: z.string().optional(),
      category: z.string().optional(),
      announcementId: z.string().optional(),
    })
    .strip(),
]);

export type WinNotificationData = z.infer<typeof winNotificationDataSchema>;
export type LossNotificationData = z.infer<typeof lossNotificationDataSchema>;
export type RoundStartNotificationData = z.infer<typeof roundStartNotificationDataSchema>;
export type BonusAvailableNotificationData = z.infer<typeof bonusAvailableNotificationDataSchema>;
export type AnnouncementNotificationData = z.infer<typeof announcementNotificationDataSchema>;

/**
 * Exhaustive schema mapping for all NotificationTypes.
 * TypeScript will produce a compilation error if any NotificationType enum member is missing.
 */
export const notificationDataSchemas: Record<NotificationType, z.ZodTypeAny> = {
  WIN: winNotificationDataSchema,
  LOSS: lossNotificationDataSchema,
  ROUND_START: roundStartNotificationDataSchema,
  BONUS_AVAILABLE: bonusAvailableNotificationDataSchema,
  ANNOUNCEMENT: announcementNotificationDataSchema,
};

/**
 * Validates the notification `data` payload against the schema for its NotificationType.
 * Strips unknown keys on object payloads.
 *
 * @param type The NotificationType to validate against.
 * @param data The notification payload to validate.
 * @returns The parsed and sanitized data payload.
 * @throws {NotificationDataValidationError} When data is invalid or type is unknown.
 */
export function validateNotificationData(
  type: NotificationType | string,
  data: unknown,
): unknown {
  const schema = notificationDataSchemas[type as NotificationType];
  if (!schema) {
    throw new NotificationDataValidationError(
      String(type),
      `Unsupported or unknown notification type: ${String(type)}`,
      [{ field: 'type', message: `Unknown notification type: ${String(type)}` }],
    );
  }

  const result = schema.safeParse(data);
  if (!result.success) {
    const details: ErrorDetail[] = (result.error.issues || []).map((issue: any) => ({
      field: issue.path && issue.path.length > 0 ? issue.path.join('.') : 'data',
      message: issue.message || 'Validation failed',
    }));

    const message = `Invalid notification data for type ${String(type)}: ${details.map((d) => `${d.field}: ${d.message}`).join(', ')}`;
    throw new NotificationDataValidationError(String(type), message, details);
  }

  return result.data;
}
