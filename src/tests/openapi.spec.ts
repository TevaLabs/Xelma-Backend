import { describe, expect, it } from "@jest/globals";
import { swaggerSpec } from "../docs/openapi";
import { isValidStellarAddress } from "../utils/stellar-address.util";

interface RequiredOperation {
  path: string;
  method: string;
  /** Response codes documented for this operation; empty means "just assert the operation exists". */
  statuses: string[];
}

/**
 * Routes a removal of would be a silent regression: wallet auth, money
 * movement (bets, predictions, round settlement), and the admin/health
 * surfaces operators depend on. Each entry's `statuses` list was verified
 * against the JSDoc in its route file — keep it in sync when responses
 * are added or removed there.
 */
const REQUIRED_OPERATIONS: RequiredOperation[] = [
  // Auth — wallet challenge/connect flow (src/routes/auth.routes.ts)
  { path: "/api/auth/challenge", method: "post", statuses: ["200", "400", "429", "500"] },
  { path: "/api/auth/connect", method: "post", statuses: ["200", "400", "401", "429", "500"] },

  // Predictions — placement and reads (src/routes/predictions.routes.ts)
  { path: "/api/predictions/submit", method: "post", statuses: ["200", "409"] },
  { path: "/api/predictions/batch-submit", method: "post", statuses: ["200", "429"] },
  { path: "/api/predictions/user", method: "get", statuses: ["200"] },
  { path: "/api/predictions/round/{roundId}", method: "get", statuses: ["200"] },

  // Bets — stub/on-chain money movement (src/routes/bets.routes.ts)
  { path: "/api/bets/up-down", method: "post", statuses: ["200", "400", "401"] },
  { path: "/api/bets/precision", method: "post", statuses: ["200", "400", "401"] },

  // Rounds — lifecycle and settlement (src/routes/rounds.routes.ts)
  { path: "/api/rounds/start", method: "post", statuses: ["200", "400", "401", "403", "409"] },
  { path: "/api/rounds/{id}/resolve", method: "post", statuses: ["200", "400", "401", "403"] },
  { path: "/api/rounds/{id}/simulate", method: "post", statuses: ["200", "400", "401", "403", "404"] },

  // Chat (src/routes/chat.routes.ts)
  { path: "/api/chat/send", method: "post", statuses: ["201", "429"] },

  // Leaderboard batch lookups (src/routes/leaderboard.routes.ts)
  { path: "/api/leaderboard/batch", method: "post", statuses: ["200"] },

  // Admin operational visibility
  { path: "/api/admin/metrics/rate-limits", method: "get", statuses: ["200"] },
  { path: "/api/admin/dead-letter", method: "get", statuses: ["200", "401", "403", "500"] },
  { path: "/api/admin/dead-letter/{id}/retry", method: "post", statuses: ["200", "401", "403", "404", "500"] },
  { path: "/api/admin/dead-letter/retry-all", method: "post", statuses: ["200", "401", "403", "500"] },
  { path: "/api/admin/cors-diagnostics", method: "get", statuses: ["200"] },

  // Health / metrics
  { path: "/health", method: "get", statuses: ["200"] },
  { path: "/metrics/readiness", method: "get", statuses: ["200", "503"] },
  { path: "/api/price", method: "get", statuses: ["200"] },
  { path: "/api/prices", method: "get", statuses: ["200"] },
];

const LEGACY_REQUIRED_OPERATIONS: Array<{ path: string; method: string }> = [
  { path: "/api/auth/challenge", method: "post" },
  { path: "/api/auth/connect", method: "post" },
  { path: "/api/predictions/submit", method: "post" },
  { path: "/api/predictions/batch-submit", method: "post" },
  { path: "/api/chat/send", method: "post" },
  { path: "/api/admin/metrics/rate-limits", method: "get" },
  { path: "/api/rounds/start", method: "post" },
  { path: "/api/price", method: "get" },
  { path: "/api/prices", method: "get" },
];

describe("OpenAPI spec", () => {
  const paths = (swaggerSpec as { paths?: Record<string, Record<string, any>> }).paths ?? {};

  it("documents every required auth, money-path, and operational route", () => {
    for (const { path, method } of REQUIRED_OPERATIONS) {
      expect(paths[path]?.[method]).toBeDefined();
    }
  });

  it("documents the response statuses each critical route relies on", () => {
    for (const { path, method, statuses } of REQUIRED_OPERATIONS) {
      const operation = paths[path]?.[method];
      for (const status of statuses) {
        if (!operation) throw new Error(`Missing OpenAPI operation: ${method.toUpperCase()} ${path}`);
        if (!operation.responses?.[status]) {
          throw new Error(`Missing OpenAPI response ${status}: ${method.toUpperCase()} ${path}`);
        }
      }
    }
  });

  it("documents legacy critical routes", () => {
    for (const { path, method } of LEGACY_REQUIRED_OPERATIONS) {
      expect(paths[path]?.[method]).toBeDefined();
    }
  });

  it("documents distinct /api/price vs /api/prices contracts", () => {
    const paths = (swaggerSpec as { paths?: Record<string, any> }).paths ?? {};
    const priceOp = paths["/api/price"]?.get;
    const pricesOp = paths["/api/prices"]?.get;

    expect(priceOp?.summary).toMatch(/XLM oracle/i);
    expect(pricesOp?.summary).toMatch(/multi-asset/i);
    expect(String(priceOp?.description ?? "")).toMatch(/Do not confuse with.*\/api\/prices/i);
    expect(String(pricesOp?.description ?? "")).toMatch(/Do not confuse with.*\/api\/price/i);
  });

  it("documents the DLQ list/retry/abandon contract", () => {
    // WHY: the admin DLQ is the only way an operator can inspect and replay a
    // failed notification/WebSocket dispatch. The routes existed but shipped
    // with almost no published contract (#857), so an operator had to read the
    // source to learn the filters, dry-run semantics, and what ABANDONED means.
    const paths = (swaggerSpec as { paths?: Record<string, any> }).paths ?? {};
    const list = paths["/api/admin/dead-letter"]?.get;
    const retry = paths["/api/admin/dead-letter/{id}/retry"]?.post;
    const retryAll = paths["/api/admin/dead-letter/retry-all"]?.post;

    expect(list.parameters.map((parameter: any) => parameter.name)).toEqual(
      expect.arrayContaining(["status", "channel", "limit", "offset"]),
    );

    const listExamples = list.responses["200"].content["application/json"].examples;
    const listRows = Object.values(listExamples).flatMap((example: any) => example.value.entries);
    expect(listRows.some((row: any) => row.status === "ABANDONED")).toBe(true);

    // A retry can succeed, stay retryable, or hit the cap and become ABANDONED.
    const retryExamples = retry.responses["200"].content["application/json"].examples;
    expect(retryExamples.resolved.value.status).toBe("RESOLVED");
    expect(retryExamples.abandoned.value.status).toBe("ABANDONED");
    expect(retryExamples.dryRun.value.dryRun).toBe(true);

    const retryAllExamples = retryAll.responses["200"].content["application/json"].examples;
    expect(retryAllExamples.abandonedOnly.value.abandoned).toBeGreaterThan(0);
    expect(retryAllExamples.dryRun.value.previews.length).toBeGreaterThan(0);

    const dlqEntry = (swaggerSpec as { components?: { schemas?: Record<string, any> } })
      .components?.schemas?.DlqEntry;
    expect(dlqEntry.properties.status.enum).toContain("ABANDONED");
  });

  it("documents 429 response on batch prediction submit", () => {
    const batchOp = paths["/api/predictions/batch-submit"]?.post;
    expect(batchOp?.responses?.["429"]).toBeDefined();
  });

  it("auth examples use valid Stellar StrKey fixtures (not placeholder strings)", () => {
    // WHY: a documented example that only *resembles* a Stellar address (a
    // string that fails StrKey checksum validation) cannot be copy-pasted by
    // consumers without hitting a 400. Every walletAddress shown in the auth
    // docs must decode as a genuine Ed25519 G... public key.
    const schemas = (swaggerSpec as { components?: { schemas?: Record<string, any> } })
      .components?.schemas ?? {};

    const challengeExample = schemas.AuthChallengeRequest?.properties?.walletAddress?.example;
    const connectExample = schemas.AuthConnectRequest?.properties?.walletAddress?.example;
    const jwtExample = (swaggerSpec as Record<string, any>).paths?.["/api/auth/challenge"]?.post
      ?.requestBody?.content?.["application/json"]?.example?.walletAddress;

    expect(isValidStellarAddress(challengeExample)).toBe(true);
    expect(isValidStellarAddress(connectExample)).toBe(true);
    expect(isValidStellarAddress(jwtExample)).toBe(true);
  });
});
