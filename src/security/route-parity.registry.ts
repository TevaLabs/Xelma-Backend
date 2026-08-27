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
  // Single-asset XLM oracle — intentionally no /api/v1/price mirror yet.
  "GET /price",
  // Multi-asset ticker is mounted after the v1 router today; keep unversioned
  // until /api/v1/prices is wired. Distinct from GET /price (different payload).
  "GET /prices",
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
  { method: "GET", path: "/", only: "main", reason: "Root welcome banner is production-only." },
  { method: "GET", path: "/health", only: "main", reason: "Production health probe is mounted at /health; the hackathon app mounts it under /api." },
  { method: "GET", path: "/api/price", only: "main", reason: "Production single-asset XLM price endpoint; the hackathon app serves /api/prices instead." },
  { method: "GET", path: "/api/errors", only: "main", reason: "Production error catalog is not part of the mock demo." },
  { method: "POST", path: "/api/auth/challenge", only: "main", reason: "Wallet auth flow is not part of the mock demo." },
  { method: "POST", path: "/api/auth/connect", only: "main", reason: "Wallet auth flow is not part of the mock demo." },
  { method: "POST", path: "/api/auth/verify", only: "main", reason: "Wallet auth flow is not part of the mock demo." },
  { method: "GET", path: "/api/user/profile", only: "main", reason: "Authenticated user surface is production-only." },
  { method: "PATCH", path: "/api/user/profile", only: "main", reason: "Authenticated user surface is production-only." },
  { method: "GET", path: "/api/user/balance", only: "main", reason: "Authenticated user surface is production-only." },
  { method: "GET", path: "/api/user/stats", only: "main", reason: "Authenticated user surface is production-only." },
  { method: "GET", path: "/api/user/transactions", only: "main", reason: "Authenticated user surface is production-only." },
  { method: "GET", path: "/api/user/:address/history", only: "main", reason: "Authenticated user surface is production-only." },
  { method: "GET", path: "/api/user/:walletAddress/public-profile", only: "main", reason: "Public profile lookup is production-only." },
  { method: "GET", path: "/api/rounds/:id", only: "main", reason: "Round detail lookup is production-only." },
  { method: "GET", path: "/api/rounds/active", only: "main", reason: "Active-round lookup is production-only." },
  { method: "POST", path: "/api/rounds/start", only: "main", reason: "Admin round creation is production-only." },
  { method: "POST", path: "/api/rounds/:id/resolve", only: "main", reason: "Oracle round resolution is production-only." },
  { method: "POST", path: "/api/rounds/:id/simulate", only: "main", reason: "Round simulation is production-only." },
  { method: "POST", path: "/api/bets/up-down", only: "main", reason: "Authenticated bet placement is production-only." },
  { method: "POST", path: "/api/bets/precision", only: "main", reason: "Authenticated bet placement is production-only." },
  { method: "POST", path: "/api/predictions/submit", only: "main", reason: "Prediction submission is production-only." },
  { method: "POST", path: "/api/predictions/batch-submit", only: "main", reason: "Prediction submission is production-only." },
  { method: "GET", path: "/api/predictions/user", only: "main", reason: "Prediction history is production-only." },
  { method: "GET", path: "/api/predictions/round/:roundId", only: "main", reason: "Per-round predictions are production-only." },
  { method: "GET", path: "/api/education/guides", only: "main", reason: "Education content is production-only." },
  { method: "GET", path: "/api/education/tip", only: "main", reason: "Education content is production-only." },
  { method: "POST", path: "/api/leaderboard/batch", only: "main", reason: "Authenticated leaderboard batch lookup is production-only." },
  { method: "GET", path: "/api/tournaments", only: "main", reason: "Tournaments surface is production-only." },
  { method: "GET", path: "/api/tournaments/:id", only: "main", reason: "Tournaments surface is production-only." },
  { method: "POST", path: "/api/tournaments/:id/join", only: "main", reason: "Tournaments surface is production-only." },
  { method: "GET", path: "/api/admin/metrics/rate-limits", only: "main", reason: "Admin surface is production-only." },
  { method: "POST", path: "/api/admin/metrics/rate-limits/clear", only: "main", reason: "Admin surface is production-only." },
  { method: "GET", path: "/api/admin/cors-diagnostics", only: "main", reason: "Admin surface is production-only." },
  { method: "GET", path: "/api/admin/dead-letter", only: "main", reason: "Admin surface is production-only." },
  { method: "POST", path: "/api/admin/dead-letter/retry-all", only: "main", reason: "Admin surface is production-only." },
  { method: "POST", path: "/api/admin/dead-letter/:id/retry", only: "main", reason: "Admin surface is production-only." },
  { method: "GET", path: "/api", only: "hackathon", reason: "Hackathon app mounts the health router under /api instead of /health." },

  { method: "GET", path: "/api/stats", only: "hackathon", reason: "Landing-page platform stats are hackathon-only." },
  { method: "GET", path: "/api/rounds", only: "hackathon", reason: "Hackathon mock rounds collection; production exposes /api/rounds/active and /api/rounds/:id." },
  { method: "POST", path: "/api/rounds/:id/bet", only: "hackathon", reason: "Hackathon mock bet stub." },
  { method: "POST", path: "/api/rounds/hackathon/up-down/:id/bet", only: "hackathon", reason: "Hackathon mock up-down bet stub." },
  { method: "POST", path: "/api/rounds/hackathon/precision/:id/bet", only: "hackathon", reason: "Hackathon mock precision bet stub." },
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
  // Education is off by default on the hackathon app; ENABLE_EDUCATION=true
  // mounts it there too (#532). The allowlist below reflects the default
  // (flag-off) surface that route-parity.spec.ts exercises.
  { method: "GET", path: "/api/education/guides", only: "main", reason: "Education is production-only; the hackathon app opts in via ENABLE_EDUCATION (default off).", flag: "education" },
  { method: "GET", path: "/api/education/tip", only: "main", reason: "Education is production-only; the hackathon app opts in via ENABLE_EDUCATION (default off).", flag: "education" },

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
