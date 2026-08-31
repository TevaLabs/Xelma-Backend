import type { Express, Application } from "express";

export type AppEntrypoint = "main" | "hackathon";

export interface RouteRecord {
  method: string;
  path: string;
}

export interface ParityAllowlistEntry {
  method: string;
  path: string;
  only: AppEntrypoint;  reason: string;
  /**
   * The `AppFeatures` flag (or mode-specific router choice) in
   * `src/app-factory.ts` that causes this route to exist in only one app.
   * Every accepted difference must trace back to a flag — if it does not,
   * it is drift rather than a decision.
   */
  flag?: string;
}

export const VERSIONED_ALIAS_ALLOWLIST: string[] = [
  // Price endpoints (/api/v1/prices and /api/v1/price) are now fully wired into the v1 mirror
];

/**
 * Intentional cross-app route differences between the production (`index.ts`)
 * and hackathon (`app.ts`) entrypoints.
 *
 * Shared mounts (auth challenge/connect/verify, user, bets, tournaments, chat,
 * notifications, leaderboard GET, metrics, docs, and `/api/prices`) must NOT
 * appear here — they exist in both apps.
 */
export const PARITY_ALLOWLIST: ParityAllowlistEntry[] = [
  // --- rootBanner ---
  { method: "GET", path: "/", only: "main", reason: "Root welcome banner is production-only.", flag: "rootBanner" },

  // --- health mount point (mode-specific) ---
  { method: "GET", path: "/health", only: "main", reason: "Production health probe sits outside /api so it is neither rate limited nor versioned.", flag: "mode: health mount" },
  { method: "GET", path: "/health/health", only: "main", reason: "Legacy alias: the health router defines its own /health path and is mounted at /health. Kept so existing probes do not break.", flag: "mode: health mount" },
  { method: "GET", path: "/api", only: "hackathon", reason: "Hackathon app answers the bare /api readiness call from the health router.", flag: "mode: health mount" },
  { method: "GET", path: "/api/health", only: "hackathon", reason: "Hackathon app serves the lightweight health check under /api.", flag: "mode: health mount" },

  // --- auth ---
  // Shared: both modes mount wallet challenge/connect/verify (#400). Do not
  // allowlist these routes — they exist in both apps.

  // --- predictions ---
  { method: "POST", path: "/api/predictions/submit", only: "main", reason: "Prediction submission requires a database and authenticated user.", flag: "predictions" },
  { method: "POST", path: "/api/predictions/batch-submit", only: "main", reason: "Prediction submission requires a database and authenticated user.", flag: "predictions" },
  { method: "GET", path: "/api/predictions/user", only: "main", reason: "Prediction history requires a database and authenticated user.", flag: "predictions" },
  { method: "GET", path: "/api/predictions/round/:roundId", only: "main", reason: "Per-round predictions require a database.", flag: "predictions" },

  // --- education ---
  { method: "GET", path: "/api/education/guides", only: "main", reason: "Education content is production-only.", flag: "education" },
  { method: "GET", path: "/api/education/tip", only: "main", reason: "Education content is production-only.", flag: "education" },

  // --- errorCatalog ---
  { method: "GET", path: "/api/errors", only: "main", reason: "Production error catalog is not part of the mock demo.", flag: "errorCatalog" },

  // --- adminRoutes ---
  { method: "GET", path: "/api/admin/metrics/rate-limits", only: "main", reason: "Admin surface is production-only.", flag: "adminRoutes" },
  { method: "POST", path: "/api/admin/metrics/rate-limits/clear", only: "main", reason: "Admin surface is production-only.", flag: "adminRoutes" },
  { method: "GET", path: "/api/admin/metrics/metrics", only: "main", reason: "Admin surface is production-only.", flag: "adminRoutes" },
  { method: "GET", path: "/api/admin/metrics/rate-limit-summary", only: "main", reason: "Admin surface is production-only.", flag: "adminRoutes" },
  { method: "GET", path: "/api/admin/cors-diagnostics", only: "main", reason: "Admin surface is production-only.", flag: "adminRoutes" },
  { method: "GET", path: "/api/admin/dead-letter", only: "main", reason: "Admin surface is production-only.", flag: "adminRoutes" },
  { method: "POST", path: "/api/admin/dead-letter/retry-all", only: "main", reason: "Admin surface is production-only.", flag: "adminRoutes" },
  { method: "POST", path: "/api/admin/dead-letter/:id/retry", only: "main", reason: "Admin surface is production-only.", flag: "adminRoutes" },
  { method: "GET", path: "/api/admin/bet-audit", only: "main", reason: "Admin surface is production-only.", flag: "adminRoutes" },

  // --- legacyPriceEndpoint ---
  { method: "GET", path: "/api/price", only: "main", reason: "Production single-asset XLM price endpoint; both apps also serve /api/prices.", flag: "legacyPriceEndpoint" },

  // --- platformStats ---
  { method: "GET", path: "/api/stats", only: "hackathon", reason: "Landing-page platform stats are hackathon-only.", flag: "platformStats" },

  // --- rounds router ---
  // Nothing to allowlist: #389 consolidated the two round routers into one
  // `routes/rounds.routes.ts` that both modes mount, so every round endpoint
  // is present in both apps and there is no accepted difference left here.

  // --- leaderboard router (mode-specific) ---
  { method: "POST", path: "/api/leaderboard/batch", only: "main", reason: "Production leaderboard router: authenticated batch lookup.", flag: "mode: leaderboard router" },
];

export function routeKey(record: RouteRecord): string {
  return `${record.method.toUpperCase()} ${record.path}`;
}

function normalizePath(rawPath: string): string {
  let path = rawPath.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  return path === "" ? "/" : path;
}

function decodeMountPath(layer: any): string {
  const regexp = layer?.regexp;
  if (!regexp || regexp.fast_slash) {
    return "";
  }
  let source: string = regexp.source;
  if (source.startsWith("^")) {
    source = source.slice(1);
  }
  source = source
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, "")
    .replace(/\\\/\?\$$/, "")
    .replace(/\$$/, "")
    .replace(/\\\//g, "/")
    .replace(/\\\./g, ".");
  return source;
}

function collectMethods(route: any): string[] {
  return Object.keys(route.methods || {})
    .filter((method) => route.methods[method] && method !== "_all")
    .map((method) => method.toUpperCase());
}

export function extractRoutes(app: Express | Application): RouteRecord[] {
  const records: RouteRecord[] = [];
  const seen = new Set<string>();

  const visit = (stack: any[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        const routePaths = Array.isArray(layer.route.path)
          ? layer.route.path
          : [layer.route.path];
        const methods = collectMethods(layer.route);
        for (const routePath of routePaths) {
          const fullPath = normalizePath(`${prefix}${routePath}`);
          for (const method of methods) {
            const record: RouteRecord = { method, path: fullPath };
            const key = routeKey(record);
            if (!seen.has(key)) {
              seen.add(key);
              records.push(record);
            }
          }
        }
      } else if (layer.name === "router" && layer.handle?.stack) {
        visit(layer.handle.stack, `${prefix}${decodeMountPath(layer)}`);
      }
    }
  };

  const router = (app as any)._router ?? (app as any).router;
  if (router?.stack) {
    visit(router.stack, "");
  }

  return records.sort((a, b) => routeKey(a).localeCompare(routeKey(b)));
}

export function getVersionedAliasDrift(mainRoutes: RouteRecord[]): {
  legacyOnly: string[];
  versionedOnly: string[];
} {
  const allow = new Set(VERSIONED_ALIAS_ALLOWLIST);

  const legacy = new Set(
    mainRoutes
      .filter((r) => r.path.startsWith("/api/") && !r.path.startsWith("/api/v1/"))
      .map((r) => `${r.method} ${r.path.replace(/^\/api/, "")}`),
  );
  const versioned = new Set(
    mainRoutes
      .filter((r) => r.path.startsWith("/api/v1/"))
      .map((r) => `${r.method} ${r.path.replace(/^\/api\/v1/, "")}`),
  );

  const legacyOnly = [...legacy]
    .filter((key) => !versioned.has(key) && !allow.has(key))
    .sort();
  const versionedOnly = [...versioned]
    .filter((key) => !legacy.has(key) && !allow.has(key))
    .sort();

  return { legacyOnly, versionedOnly };
}

export function getCrossAppDrift(
  mainRoutes: RouteRecord[],
  hackathonRoutes: RouteRecord[],
): { mainOnly: string[]; hackathonOnly: string[]; staleAllowlist: string[] } {
  const mainLegacy = mainRoutes.filter((r) => !r.path.startsWith("/api/v1/"));
  const mainKeys = new Set(mainLegacy.map(routeKey));
  const hackKeys = new Set(hackathonRoutes.map(routeKey));

  const allowMain = new Set(
    PARITY_ALLOWLIST.filter((e) => e.only === "main").map(routeKey),
  );
  const allowHackathon = new Set(
    PARITY_ALLOWLIST.filter((e) => e.only === "hackathon").map(routeKey),
  );

  const mainOnly = mainLegacy
    .map(routeKey)
    .filter((key) => !hackKeys.has(key) && !allowMain.has(key))
    .sort();
  const hackathonOnly = hackathonRoutes
    .map(routeKey)
    .filter((key) => !mainKeys.has(key) && !allowHackathon.has(key))
    .sort();

  const staleAllowlist = PARITY_ALLOWLIST.filter((entry) => {
    const key = routeKey(entry);
    if (entry.only === "main") {
      return !mainKeys.has(key) || hackKeys.has(key);
    }
    return !hackKeys.has(key) || mainKeys.has(key);
  })
    .map(routeKey)
    .sort();

  return { mainOnly, hackathonOnly, staleAllowlist };
}
