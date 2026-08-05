import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

jest.mock("@prisma/client", () => ({
  UserRole: { USER: "USER", ADMIN: "ADMIN", ORACLE: "ORACLE" },
  Prisma: {},
}));

jest.mock("../services/websocket.service", () => ({
  __esModule: true,
  default: {
    initialize: jest.fn(),
    emitRoundUpdate: jest.fn(),
    emitPriceUpdate: jest.fn(),
    emitBetAccepted: jest.fn(),
    safeEmit: jest.fn(),
  },
  WebSocketEvents: {},
}));

jest.mock("../services/stellar.service", () => ({
  isValidStellarAddress: (address: string) =>
    address && address.startsWith("G") && address.length === 56,
  verifySignature: jest.fn(),
}));

jest.mock("../services/soroban.service", () => ({
  __esModule: true,
  default: {
    getUserStats: jest.fn(),
    getPendingWinnings: jest.fn(),
    getHealth: jest.fn(),
    init: jest.fn(),
  },
  getUserStats: jest.fn(),
  getPendingWinnings: jest.fn(),
  getHealth: jest.fn(),
}));

jest.mock("../config/preflight", () => ({
  assertPreflightOrExit: jest.fn(),
}));

jest.mock("../utils/bindings-validator", () => ({
  validateVendoredBindings: jest.fn(() => ({
    ok: true,
    info: { vendorPath: "mock", packageName: "mock" },
  })),
}));

jest.mock("../services/oracle", () => ({
  __esModule: true,
  default: {
    getPriceString: jest.fn(() => "0.1"),
    getLastUpdatedAt: jest.fn(() => new Date()),
    isStale: jest.fn(() => false),
    getLastProvider: jest.fn(() => "mock"),
    getActiveSource: jest.fn(() => "mock"),
  },
}));

jest.mock("../services/scheduler.service", () => ({
  __esModule: true,
  default: { start: jest.fn(), stop: jest.fn() },
}));

jest.mock("../services/round-scheduler.service", () => ({
  __esModule: true,
  default: { start: jest.fn(), stop: jest.fn() },
}));

jest.mock("../services/oracle.service", () => ({
  __esModule: true,
  default: { start: jest.fn(), stop: jest.fn() },
}));

jest.mock("../services/resolution.service", () => ({
  __esModule: true,
  default: { resolveRound: jest.fn() },
}));

jest.mock("../services/round.service", () => ({
  __esModule: true,
  default: {
    getRoundById: jest.fn(),
    getActiveRound: jest.fn(),
    startRound: jest.fn(),
  },
}));

jest.mock("../services/simulation.service", () => ({
  __esModule: true,
  default: { simulateRound: jest.fn() },
}));

jest.mock("../services/priceService", () => ({
  getPrices: jest.fn(async () => ({ btc: 1, eth: 2, xlm: 0.1, stale: false })),
}));

jest.mock("../routes/bets.routes", () => {
  const { Router } = require("express");
  const router = Router();
  router.post("/up-down", (_req: unknown, res: { json: (b: unknown) => void }) =>
    res.json({ ok: true }),
  );
  router.post("/precision", (_req: unknown, res: { json: (b: unknown) => void }) =>
    res.json({ ok: true }),
  );
  return { __esModule: true, default: router };
});

import { createApp as createMainApp } from "../index";
import { createApp as createHackathonApp } from "../app";
import {
  extractRoutes,
  getCrossAppDrift,
  getVersionedAliasDrift,
  PARITY_ALLOWLIST,
  routeKey,
} from "../security/route-parity.registry";

// ---------------------------------------------------------------------------
// Diff-artifact helpers
// ---------------------------------------------------------------------------

/** Absolute path for the JSON diff artifact written on failure. */
const DIFF_ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "route-parity-diff.json",
);

/**
 * Top-level diff shape accumulated across all checks in this suite.
 * Written to DIFF_ARTIFACT_PATH so CI can upload it as a build artifact.
 */
interface ParityDiff {
  generatedAt: string;
  mainRouteCount: number;
  hackathonRouteCount: number;
  versionedAlias: {
    legacyOnly: string[];
    versionedOnly: string[];
  };
  crossApp: {
    mainOnly: string[];
    hackathonOnly: string[];
    staleAllowlist: string[];
  };
  allowlistDuplicates: string[];
}

const diff: ParityDiff = {
  generatedAt: new Date().toISOString(),
  mainRouteCount: 0,
  hackathonRouteCount: 0,
  versionedAlias: { legacyOnly: [], versionedOnly: [] },
  crossApp: { mainOnly: [], hackathonOnly: [], staleAllowlist: [] },
  allowlistDuplicates: [],
};

/** Persist the accumulated diff so CI can upload it as an artifact. */
function flushDiffArtifact(): void {
  try {
    fs.writeFileSync(DIFF_ARTIFACT_PATH, JSON.stringify(diff, null, 2), "utf8");
  } catch {
    // Non-fatal: artifact write failure must not mask the real test failure.
  }
}

// ---------------------------------------------------------------------------
// Human-readable formatting helpers
// ---------------------------------------------------------------------------

/** Column widths for the route table. */
const COL_METHOD = 8;
const COL_PATH = 55;

function padEnd(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

/** Render a labelled table section for a list of "METHOD PATH" strings. */
function formatRouteTable(label: string, routes: string[]): string {
  if (routes.length === 0) return "";
  const header =
    `  ${padEnd("METHOD", COL_METHOD)} ${padEnd("PATH", COL_PATH)}\n` +
    `  ${"-".repeat(COL_METHOD)} ${"-".repeat(COL_PATH)}`;
  const rows = routes
    .map((r) => {
      const [method, ...rest] = r.split(" ");
      const p = rest.join(" ");
      return `  ${padEnd(method, COL_METHOD)} ${padEnd(p, COL_PATH)}`;
    })
    .join("\n");
  return `\n${label} (${routes.length}):\n${header}\n${rows}`;
}

/**
 * Suggest the PARITY_ALLOWLIST snippet a contributor should add for each
 * route that is exclusive to one app.
 */
function formatAllowlistHints(
  routes: string[],
  only: "main" | "hackathon",
): string {
  if (routes.length === 0) return "";
  const lines = routes.map((r) => {
    const [method, ...rest] = r.split(" ");
    const p = rest.join(" ");
    return (
      `  { method: "${method}", path: "${p}", only: "${only}",` +
      ` reason: "TODO: explain why this route exists only in ${only}" },`
    );
  });
  return (
    `\n  ── Allowlist hints (add to PARITY_ALLOWLIST in route-parity.registry.ts` +
    ` if intentional) ──\n${lines.join("\n")}`
  );
}

/**
 * Build the full human-readable annotation for a cross-app parity failure.
 * Printed to stderr so it surfaces prominently in Jest output and GitHub
 * Actions log groups.
 */
function buildCrossAppAnnotation(
  mainOnly: string[],
  hackathonOnly: string[],
): string {
  const total = mainOnly.length + hackathonOnly.length;
  const parts: string[] = [
    `\n${"-".repeat(72)}`,
    `ROUTE-PARITY FAILURE — ${total} route(s) exist in only one app`,
    `-".repeat(72)}`,
    formatRouteTable(
      "Routes only in the MAIN app (missing from hackathon app)",
      mainOnly,
    ),
    formatAllowlistHints(mainOnly, "main"),
    formatRouteTable(
      "Routes only in the HACKATHON app (missing from main app)",
      hackathonOnly,
    ),
    formatAllowlistHints(hackathonOnly, "hackathon"),
    `\nFix: Either add the missing route to the other app, or add an entry`,
    `to PARITY_ALLOWLIST in src/security/route-parity.registry.ts`,
    `with a clear 'reason' explaining why the asymmetry is intentional.`,
    `-".repeat(72)}\n`,
  ];
  return parts.filter(Boolean).join("\n");
}

/**
 * Build the full human-readable annotation for a versioned-alias parity
 * failure (routes under /api/* not mirrored under /api/v1/* or vice-versa).
 */
function buildVersionedAliasAnnotation(
  legacyOnly: string[],
  versionedOnly: string[],
): string {
  const total = legacyOnly.length + versionedOnly.length;
  const parts: string[] = [
    `\n${"-".repeat(72)}`,
    `VERSIONED-ALIAS FAILURE — ${total} route(s) are not mirrored between /api and /api/v1`,
    `-".repeat(72)}`,
    formatRouteTable(
      "Routes in /api/* but NOT in /api/v1/* (add to v1Router in src/index.ts)",
      legacyOnly,
    ),
    formatRouteTable(
      "Routes in /api/v1/* but NOT in /api/* (orphaned versioned route)",
      versionedOnly,
    ),
    `\nFix: Mirror every route in both the legacy '/api' and versioned '/api/v1'`,
    `routers in src/index.ts, OR add the route key to VERSIONED_ALIAS_ALLOWLIST`,
    `in src/security/route-parity.registry.ts if the asymmetry is intentional.`,
    `-".repeat(72)}\n`,
  ];
  return parts.filter(Boolean).join("\n");
}

/**
 * Build the annotation for stale allowlist entries (routes listed in
 * PARITY_ALLOWLIST that no longer exist or are no longer asymmetric).
 */
function buildStaleAllowlistAnnotation(stale: string[]): string {
  const parts: string[] = [
    `\n${"-".repeat(72)}`,
    `STALE-ALLOWLIST FAILURE — ${stale.length} allowlist entry(ies) are no longer valid`,
    `-".repeat(72)}`,
    formatRouteTable(
      "Stale entries (route no longer exists or asymmetry has been resolved)",
      stale,
    ),
    `\nFix: Remove the stale entries from PARITY_ALLOWLIST in`,
    `src/security/route-parity.registry.ts.`,
    `-".repeat(72)}\n`,
  ];
  return parts.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const mainRoutes = extractRoutes(createMainApp());
const hackathonRoutes = extractRoutes(createHackathonApp());

diff.mainRouteCount = mainRoutes.length;
diff.hackathonRouteCount = hackathonRoutes.length;

afterAll(() => {
  // Always flush so CI has an artifact even when all tests pass.
  flushDiffArtifact();
});

describe("route parity", () => {
  // ── 1. Inventory smoke-test ────────────────────────────────────────────────
  it("inventories at least the documented core routes from both apps", () => {
    const annotation = [
      `\nROUTE-INVENTORY CHECK`,
      `  Main app routes found   : ${mainRoutes.length}  (expected > 20)`,
      `  Hackathon routes found  : ${hackathonRoutes.length}  (expected > 3)`,
      `\n  If these counts are unexpectedly low the Express app likely failed`,
      `  to mount its routers. Check startup errors above.`,
    ].join("\n");

    if (mainRoutes.length <= 20 || hackathonRoutes.length <= 3) {
      process.stderr.write(annotation + "\n");
    }

    expect(mainRoutes.length).toBeGreaterThan(20);
    expect(hackathonRoutes.length).toBeGreaterThan(3);
  });

  // ── 2. Versioned alias parity ─────────────────────────────────────────────
  it("mirrors every /api route under the /api/v1 alias", () => {
    const { legacyOnly, versionedOnly } = getVersionedAliasDrift(mainRoutes);

    diff.versionedAlias = { legacyOnly, versionedOnly };
    flushDiffArtifact();

    if (legacyOnly.length > 0 || versionedOnly.length > 0) {
      process.stderr.write(
        buildVersionedAliasAnnotation(legacyOnly, versionedOnly),
      );
    }

    expect({ legacyOnly, versionedOnly }).toEqual({
      legacyOnly: [],
      versionedOnly: [],
    });
  });

  // ── 3. Cross-app route parity ─────────────────────────────────────────────
  it("has no route present in only one app outside the allowlist", () => {
    const { mainOnly, hackathonOnly } = getCrossAppDrift(
      mainRoutes,
      hackathonRoutes,
    );

    diff.crossApp.mainOnly = mainOnly;
    diff.crossApp.hackathonOnly = hackathonOnly;
    flushDiffArtifact();

    if (mainOnly.length > 0 || hackathonOnly.length > 0) {
      process.stderr.write(buildCrossAppAnnotation(mainOnly, hackathonOnly));
    }

    expect({ mainOnly, hackathonOnly }).toEqual({
      mainOnly: [],
      hackathonOnly: [],
    });
  });

  // ── 4. Stale allowlist ────────────────────────────────────────────────────
  it("keeps the parity allowlist free of stale entries", () => {
    const { staleAllowlist } = getCrossAppDrift(mainRoutes, hackathonRoutes);

    diff.crossApp.staleAllowlist = staleAllowlist;
    flushDiffArtifact();

    if (staleAllowlist.length > 0) {
      process.stderr.write(buildStaleAllowlistAnnotation(staleAllowlist));
    }

    expect(staleAllowlist).toEqual([]);
  });

  // ── 5. Allowlist integrity ────────────────────────────────────────────────
  it("has no duplicate allowlist entries", () => {
    const keys = PARITY_ALLOWLIST.map(routeKey);
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const key of keys) {
      if (seen.has(key)) duplicates.push(key);
      else seen.add(key);
    }

    diff.allowlistDuplicates = duplicates;
    flushDiffArtifact();

    if (duplicates.length > 0) {
      const lines = duplicates.map((d) => `  ${d}`).join("\n");
      process.stderr.write(
        `\n${"-".repeat(72)}\n` +
          `DUPLICATE-ALLOWLIST FAILURE — ${duplicates.length} duplicate(s) found\n` +
          `-".repeat(72)}\n` +
          `${lines}\n` +
          `\nFix: Remove the duplicate entries from PARITY_ALLOWLIST in\n` +
          `src/security/route-parity.registry.ts.\n` +
          `-".repeat(72)}\n`,
      );
    }

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("ties every accepted difference back to a feature flag", () => {
    const unattributed = PARITY_ALLOWLIST.filter(
      (entry) => !entry.flag || entry.flag.trim() === "",
    ).map(routeKey);

    expect(unattributed).toEqual([]);
  });

  it("gives every allowlist entry a non-empty reason", () => {
    const unexplained = PARITY_ALLOWLIST.filter(
      (entry) => !entry.reason || entry.reason.trim() === "",
    ).map(routeKey);

    expect(unexplained).toEqual([]);
  });
});
