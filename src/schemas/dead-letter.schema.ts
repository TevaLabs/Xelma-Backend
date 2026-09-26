/**
 * Query validation for the admin dead-letter queue list endpoint.
 *
 * Uses the repo's canonical offset/limit pagination shape (limit 1–100,
 * default 20) so the DLQ list cannot dump the whole FailedDispatch table in
 * one response. `status` / `channel` are lower- or upper-case tolerant to
 * match how operators paste filter values.
 */
import { z } from "zod";

const coerceInt = (fallback: number) =>
  z
    .preprocess((v) => {
      if (typeof v === "string") return Number(v);
      return v;
    }, z.number().int())
    .default(fallback);

/** Uppercase a string before enum matching; leave other values untouched. */
const uppercaseString = (v: unknown): unknown =>
  typeof v === "string" ? v.toUpperCase() : v;

export const dispatchStatusSchema = z.enum([
  "PENDING",
  "RETRYING",
  "RESOLVED",
  "ABANDONED",
]);

export const dispatchChannelSchema = z.enum([
  "NOTIFICATION_CREATE",
  "WEBSOCKET_EMIT",
]);

export const adminDeadLetterListQuerySchema = z.object({
  limit: coerceInt(20).pipe(z.number().int().min(1).max(100)),
  offset: coerceInt(0).pipe(z.number().int().min(0)),
  status: z.preprocess(uppercaseString, dispatchStatusSchema.optional()),
  channel: z.preprocess(uppercaseString, dispatchChannelSchema.optional()),
});

export type AdminDeadLetterListQuery = z.infer<
  typeof adminDeadLetterListQuerySchema
>;
