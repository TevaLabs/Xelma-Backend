import { UserRole } from "@prisma/client";

/**
 * Minimum authorization required to call a route.
 * Used by tests and documentation to prevent auth drift when routes are added.
 */
export enum RouteAuthLevel {
  PUBLIC = "public",
  /** Valid JWT; any role */
  AUTHENTICATED = "authenticated",
  /** Valid JWT with ADMIN role */
  ADMIN = "admin",
  /** Valid JWT with ORACLE or ADMIN role */
  ORACLE = "oracle",
  /** Valid JWT optional; enriches response when present */
  OPTIONAL_AUTH = "optional_auth",
}

export interface RouteAuthEntry {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Full mounted path (e.g. /api/predictions/submit) */
  path: string;
  auth: RouteAuthLevel;
  /** Human-readable note for contributors */
  notes?: string;
}

/**
 * Canonical map of HTTP API routes and their authorization requirements.
 * Update this registry whenever a route is added or its auth changes.
 */
export const ROUTE_AUTH_REGISTRY: RouteAuthEntry[] = [
  // Auth
  { method: "POST", path: "/api/auth/challenge", auth: RouteAuthLevel.PUBLIC, notes: "Rate limited per IP" },
  { method: "POST", path: "/api/auth/connect", auth: RouteAuthLevel.PUBLIC, notes: "Rate limited per IP" },

  // User
  { method: "GET", path: "/api/user/profile", auth: RouteAuthLevel.AUTHENTICATED },
  { method: "GET", path: "/api/user/balance", auth: RouteAuthLevel.AUTHENTICATED },
  { method: "GET", path: "/api/user/stats", auth: RouteAuthLevel.AUTHENTICATED },
  { method: "PATCH", path: "/api/user/profile", auth: RouteAuthLevel.AUTHENTICATED },
  { method: "GET", path: "/api/user/transactions", auth: RouteAuthLevel.AUTHENTICATED },
  { method: "GET", path: "/api/user/:walletAddress/public-profile", auth: RouteAuthLevel.PUBLIC },

  // Rounds
  { method: "POST", path: "/api/rounds/start", auth: RouteAuthLevel.ADMIN },
  { method: "GET", path: "/api/rounds/:id", auth: RouteAuthLevel.PUBLIC },
  { method: "GET", path: "/api/rounds/active", auth: RouteAuthLevel.PUBLIC },
  { method: "POST", path: "/api/rounds/:id/resolve", auth: RouteAuthLevel.ORACLE },

  // Bets (JWT required — wallet bound from token)
  { method: "POST", path: "/api/bets/up-down", auth: RouteAuthLevel.AUTHENTICATED },
  { method: "POST", path: "/api/bets/precision", auth: RouteAuthLevel.AUTHENTICATED },

  // Predictions
  { method: "POST", path: "/api/predictions/submit", auth: RouteAuthLevel.AUTHENTICATED },
  { method: "POST", path: "/api/predictions/batch-submit", auth: RouteAuthLevel.AUTHENTICATED },
  { method: "GET", path: "/api/predictions/user", auth: RouteAuthLevel.AUTHENTICATED },
  { method: "GET", path: "/api/predictions/round/:roundId", auth: RouteAuthLevel.PUBLIC },

  // Education
  { method: "GET", path: "/api/education/guides", auth: RouteAuthLevel.PUBLIC },
  { method: "GET", path: "/api/education/tip", auth: RouteAuthLevel.PUBLIC },

  // Leaderboard
  { method: "GET", path: "/api/leaderboard", auth: RouteAuthLevel.OPTIONAL_AUTH },
  { method: "POST", path: "/api/leaderboard/batch", auth: RouteAuthLevel.AUTHENTICATED },

  // Chat
  { method: "POST", path: "/api/chat/send", auth: RouteAuthLevel.AUTHENTICATED },
  { method: "GET", path: "/api/chat/history", auth: RouteAuthLevel.PUBLIC },

  // Notifications (all authenticated)
  { method: "GET", path: "/api/notifications", auth: RouteAuthLevel.AUTHENTICATED },
  { method: "GET", path: "/api/notifications/unread-count", auth: RouteAuthLevel.AUTHENTICATED },
  { method: "GET", path: "/api/notifications/:id", auth: RouteAuthLevel.AUTHENTICATED },
  { method: "PATCH", path: "/api/notifications/:id/read", auth: RouteAuthLevel.AUTHENTICATED },
  { method: "PATCH", path: "/api/notifications/read-all", auth: RouteAuthLevel.AUTHENTICATED },
  { method: "DELETE", path: "/api/notifications/:id", auth: RouteAuthLevel.AUTHENTICATED },
  { method: "DELETE", path: "/api/notifications", auth: RouteAuthLevel.AUTHENTICATED },

  // Admin
  { method: "GET", path: "/api/admin/metrics/rate-limits", auth: RouteAuthLevel.ADMIN },
  { method: "POST", path: "/api/admin/metrics/rate-limits/clear", auth: RouteAuthLevel.ADMIN },
  { method: "GET", path: "/api/admin/cors-diagnostics", auth: RouteAuthLevel.ADMIN },
  { method: "GET", path: "/api/admin/dead-letter", auth: RouteAuthLevel.ADMIN },
  { method: "POST", path: "/api/admin/dead-letter/retry-all", auth: RouteAuthLevel.ADMIN },
  { method: "POST", path: "/api/admin/dead-letter/:id/retry", auth: RouteAuthLevel.ADMIN },

  // System / misc API
  { method: "GET", path: "/api/prices", auth: RouteAuthLevel.PUBLIC, notes: "Multi-asset price ticker with stale flag" },
  { method: "GET", path: "/api/price", auth: RouteAuthLevel.PUBLIC },
  { method: "GET", path: "/api/errors", auth: RouteAuthLevel.PUBLIC },
  { method: "GET", path: "/metrics", auth: RouteAuthLevel.PUBLIC },
  { method: "GET", path: "/health", auth: RouteAuthLevel.PUBLIC },
  { method: "GET", path: "/", auth: RouteAuthLevel.PUBLIC },
];

/** Roles that satisfy ORACLE-level routes */
export const ORACLE_ALLOWED_ROLES: UserRole[] = [UserRole.ORACLE, UserRole.ADMIN];

export function registryKey(entry: RouteAuthEntry): string {
  return `${entry.method} ${entry.path}`;
}

export function getRegistryByPath(): Map<string, RouteAuthEntry> {
  const map = new Map<string, RouteAuthEntry>();
  for (const entry of ROUTE_AUTH_REGISTRY) {
    const key = registryKey(entry);
    if (map.has(key)) {
      throw new Error(`Duplicate route auth registry entry: ${key}`);
    }
    map.set(key, entry);
  }
  return map;
}

export function getProtectedRoutes(): RouteAuthEntry[] {
  return ROUTE_AUTH_REGISTRY.filter((e) => e.auth !== RouteAuthLevel.PUBLIC);
}

export function getAdminRoutes(): RouteAuthEntry[] {
  return ROUTE_AUTH_REGISTRY.filter((e) => e.auth === RouteAuthLevel.ADMIN);
}

export function getOracleRoutes(): RouteAuthEntry[] {
  return ROUTE_AUTH_REGISTRY.filter((e) => e.auth === RouteAuthLevel.ORACLE);
}
