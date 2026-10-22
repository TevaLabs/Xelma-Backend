import { z } from 'zod';
import { unifiedPaginationSchema } from './pagination.schema';

export const sendMessageSchema = z.object({
  content: z
    .string()
    .min(1, 'Message content is required')
    .max(500, 'Message cannot exceed 500 characters'),
});

/**
 * Query schema for `GET /api/chat/history`.
 *
 * Extends the shared pagination contract with `before` — an ISO 8601
 * timestamp cursor used to page backwards through chat history (Issue #848).
 * Both `before` and the opaque `cursor` are accepted; `cursor` wins when both
 * are supplied.
 */
export const chatHistoryQuerySchema = unifiedPaginationSchema.extend({
  before: z
    .string()
    .refine(value => !Number.isNaN(Date.parse(value)), {
      message: 'before must be an ISO 8601 timestamp',
    })
    .optional(),
});

export type ChatHistoryQueryParams = z.infer<typeof chatHistoryQuerySchema>;
