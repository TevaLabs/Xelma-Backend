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
  { path: "/api/predictions/submit", method: "post", statuses: ["200", "400", "401", "403", "409", "429"] },
  { path: "/api/predictions/batch-submit", method: "post", statuses: ["200", "400", "401", "403", "429"] },
  { path: "/api/predictions/user", method: "get", statuses: ["200"] },
  { path: "/api/predictions/round/{roundId}", method: "get", statuses: ["200"] },

  // Bets — stub/on-chain money movement (src/routes/bets.routes.ts)
  { path: "/api/bets/up-down", method: "post", statuses: ["200", "400", "401", "403", "429"] },
  { path: "/api/bets/precision", method: "post", statuses: ["200", "400", "401", "403", "429"] },
  { path: "/api/bets/claim", method: "post", statuses: ["200", "400", "401", "403", "409", "422", "429", "503"] },

  // Rounds — lifecycle and settlement (src/routes/rounds.routes.ts)
  { path: "/api/rounds/start", method: "post", statuses: ["200", "400", "401", "403", "409"] },
  { path: "/api/rounds/{id}/bet", method: "post", statuses: ["200", "400", "401", "403", "404", "409", "429"] },
  { path: "/api/rounds/{id}/resolve", method: "post", statuses: ["200", "400", "401", "403"] },
  { path: "/api/rounds/{id}/simulate", method: "post", statuses: ["200", "400", "401", "403", "404"] },

  // Chat (src/routes/chat.routes.ts)
  { path: "/api/chat/send", method: "post", statuses: ["201", "429"] },

  // Leaderboard batch lookups (src/routes/leaderboard.routes.ts)
  { path: "/api/leaderboard/batch", method: "post", statuses: ["200"] },

  // Admin operational visibility
  { path: "/api/admin/metrics/rate-limits", method: "get", statuses: ["200"] },
  { path: "/api/admin/dead-letter", method: "get", statuses: [] },
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
  const schemas = (swaggerSpec as { components?: { schemas?: Record<string, any> } })
    .components?.schemas ?? {};

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

  it("registers shared error response schemas with consistent envelopes", () => {
    expect(schemas.BaseErrorResponse).toBeDefined();
    expect(schemas.ErrorResponse).toBeDefined();
    expect(schemas.UnauthorizedResponse).toBeDefined();
    expect(schemas.ForbiddenResponse).toBeDefined();
    expect(schemas.RateLimitResponse).toBeDefined();
    expect(schemas.ValidationErrorResponse).toBeDefined();

    // Verify properties on BaseErrorResponse
    expect(schemas.BaseErrorResponse.properties?.error).toBeDefined();
    expect(schemas.BaseErrorResponse.properties?.message).toBeDefined();
    expect(schemas.BaseErrorResponse.properties?.code).toBeDefined();
    expect(schemas.BaseErrorResponse.properties?.path).toBeDefined();
    expect(schemas.BaseErrorResponse.properties?.requestId).toBeDefined();
    expect(schemas.BaseErrorResponse.properties?.timestamp).toBeDefined();
    expect(schemas.BaseErrorResponse.properties?.retryAfter).toBeDefined();

    // Verify allOf composition for derived error responses
    expect(schemas.UnauthorizedResponse.allOf?.[0]?.$ref).toBe('#/components/schemas/ErrorResponse');
    expect(schemas.ForbiddenResponse.allOf?.[0]?.$ref).toBe('#/components/schemas/ErrorResponse');
    expect(schemas.RateLimitResponse.allOf?.[0]?.$ref).toBe('#/components/schemas/ErrorResponse');
    expect(schemas.ValidationErrorResponse.allOf?.[0]?.$ref).toBe('#/components/schemas/ErrorResponse');
  });

  it("documents 401, 403, and 429 error responses on all money POST routes with matching examples", () => {
    const moneyRoutes = [
      "/api/bets/up-down",
      "/api/bets/precision",
      "/api/bets/claim",
      "/api/predictions/submit",
      "/api/predictions/batch-submit",
      "/api/rounds/{id}/bet",
    ];

    for (const route of moneyRoutes) {
      const op = paths[route]?.post;
      expect(op).toBeDefined();

      // Check 401
      const res401 = op.responses?.["401"];
      expect(res401).toBeDefined();
      const content401 = res401.content?.["application/json"];
      expect(
        content401?.schema?.$ref || content401?.schema?.properties?.error
      ).toBeTruthy();

      // Check 403
      const res403 = op.responses?.["403"];
      expect(res403).toBeDefined();
      const content403 = res403.content?.["application/json"];
      expect(
        content403?.schema?.$ref || content403?.schema?.properties?.error
      ).toBeTruthy();

      // Check 429
      const res429 = op.responses?.["429"];
      expect(res429).toBeDefined();
      const content429 = res429.content?.["application/json"];
      expect(
        content429?.schema?.$ref || content429?.schema?.properties?.error
      ).toBeTruthy();

      // Verify example structure if examples are provided
      if (content401?.examples) {
        for (const exampleKey of Object.keys(content401.examples)) {
          const val = content401.examples[exampleKey].value;
          expect(val.error).toBeDefined();
          expect(val.message).toBeDefined();
          expect(val.code).toBeDefined();
          expect(val.requestId).toBeDefined();
          expect(val.timestamp).toBeDefined();
        }
      }

      if (content429?.examples) {
        for (const exampleKey of Object.keys(content429.examples)) {
          const val = content429.examples[exampleKey].value;
          expect(val.error).toBeDefined();
          expect(val.message).toBeDefined();
          expect(val.code).toBeDefined();
          expect(val.retryAfter).toBeDefined();
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

  it("documents 429 response on batch prediction submit", () => {
    const batchOp = paths["/api/predictions/batch-submit"]?.post;
    expect(batchOp?.responses?.["429"]).toBeDefined();
  });

  it("auth examples use valid Stellar StrKey fixtures (not placeholder strings)", () => {
    const challengeExample = schemas.AuthChallengeRequest?.properties?.walletAddress?.example;
    const connectExample = schemas.AuthConnectRequest?.properties?.walletAddress?.example;
    const jwtExample = (swaggerSpec as Record<string, any>).paths?.["/api/auth/challenge"]?.post
      ?.requestBody?.content?.["application/json"]?.example?.walletAddress;

    expect(isValidStellarAddress(challengeExample)).toBe(true);
    expect(isValidStellarAddress(connectExample)).toBe(true);
    expect(isValidStellarAddress(jwtExample)).toBe(true);
  });
});
