import { describe, expect, it } from "@jest/globals";
import { swaggerSpec } from "../docs/openapi";

const REQUIRED_OPERATIONS: Array<{ path: string; method: string }> = [
  { path: "/api/auth/challenge", method: "post" },
  { path: "/api/auth/connect", method: "post" },
  { path: "/api/predictions/submit", method: "post" },
  { path: "/api/predictions/batch-submit", method: "post" },
  { path: "/api/chat/send", method: "post" },
  { path: "/api/admin/metrics/rate-limits", method: "get" },
  { path: "/api/rounds/start", method: "post" },
];

describe("OpenAPI spec", () => {
  it("documents core gameplay and admin routes", () => {
    const paths = (swaggerSpec as { paths?: Record<string, Record<string, unknown>> }).paths ?? {};

    for (const { path, method } of REQUIRED_OPERATIONS) {
      expect(paths[path]?.[method]).toBeDefined();
    }
  });

  it("documents 429 response on batch prediction submit", () => {
    const paths = (swaggerSpec as { paths?: Record<string, any> }).paths ?? {};
    const batchOp = paths["/api/predictions/batch-submit"]?.post;
    expect(batchOp?.responses?.["429"]).toBeDefined();
  });
});
