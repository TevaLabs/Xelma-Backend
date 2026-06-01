/**
 * Rate-limit endpoint names and operator-facing categories.
 * Keep in sync with rateLimiter.middleware.ts `name` fields.
 */
export type RateLimitCategory = "auth" | "prediction" | "chat" | "admin" | "oracle" | "other";

export const RATE_LIMIT_ENDPOINT_CATEGORIES: Record<string, RateLimitCategory> = {
  "auth/challenge": "auth",
  "auth/connect": "auth",
  "auth/general": "auth",
  "chat/message": "chat",
  "prediction/submit": "prediction",
  "prediction/batch-submit": "prediction",
  "admin/round-create": "admin",
  "oracle/round-resolve": "oracle",
  "leaderboard/batch": "other",
};

export function getRateLimitCategory(endpoint: string): RateLimitCategory {
  return RATE_LIMIT_ENDPOINT_CATEGORIES[endpoint] ?? "other";
}

/** Endpoints surfaced in the operator suspicious-activity dashboard */
export const OPERATOR_MONITORED_CATEGORIES: RateLimitCategory[] = [
  "auth",
  "prediction",
  "chat",
];
