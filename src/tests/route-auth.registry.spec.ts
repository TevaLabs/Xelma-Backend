import { describe, expect, it } from "@jest/globals";
import {
  getAdminRoutes,
  getOracleRoutes,
  getProtectedRoutes,
  getRegistryByPath,
  ROUTE_AUTH_REGISTRY,
  RouteAuthLevel,
} from "../security/route-auth.registry";

describe("route-auth.registry", () => {
  it("has no duplicate method+path entries", () => {
    expect(() => getRegistryByPath()).not.toThrow();
    expect(ROUTE_AUTH_REGISTRY.length).toBeGreaterThan(20);
  });

  it("marks admin-only routes as ADMIN", () => {
    const adminPaths = getAdminRoutes().map((r) => r.path);
    expect(adminPaths).toContain("/api/rounds/start");
    expect(adminPaths).toContain("/api/admin/metrics/rate-limits");
    expect(adminPaths.every((p) => p.startsWith("/api/"))).toBe(true);
  });

  it("marks oracle resolve route as ORACLE", () => {
    const oraclePaths = getOracleRoutes().map((r) => r.path);
    expect(oraclePaths).toEqual(["/api/rounds/:id/resolve"]);
  });

  it("requires auth on batch mutation endpoints", () => {
    const protectedPaths = getProtectedRoutes();
    const batchPrediction = protectedPaths.find(
      (r) => r.path === "/api/predictions/batch-submit",
    );
    const batchLeaderboard = protectedPaths.find(
      (r) => r.path === "/api/leaderboard/batch",
    );

    expect(batchPrediction?.auth).toBe(RouteAuthLevel.AUTHENTICATED);
    expect(batchLeaderboard?.auth).toBe(RouteAuthLevel.AUTHENTICATED);
  });
});
