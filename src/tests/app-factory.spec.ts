import { describe, expect, it } from "@jest/globals";

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

import { createApp, resolveFeatures } from "../app-factory";
import { createApp as createMainApp } from "../index";
import { createApp as createHackathonApp } from "../app";
import { extractRoutes, routeKey } from "../security/route-parity.registry";

const pathsOf = (app: any): Set<string> =>
  new Set(extractRoutes(app).map(routeKey));

describe("app factory", () => {
  describe("both entrypoints are built by the factory", () => {
    it("produces the same route set for src/index.ts as mode: full", () => {
      expect(pathsOf(createMainApp())).toEqual(pathsOf(createApp({ mode: "full" })));
    });

    it("produces the same route set for src/app.ts as mode: hackathon", () => {
      expect(pathsOf(createHackathonApp())).toEqual(
        pathsOf(createApp({ mode: "hackathon" })),
      );
    });

    it("builds two genuinely different apps from the same factory", () => {
      const full = pathsOf(createApp({ mode: "full" }));
      const hackathon = pathsOf(createApp({ mode: "hackathon" }));

      expect(full).not.toEqual(hackathon);
    });
  });

  describe("feature flag defaults", () => {
    it("enables the full surface in full mode", () => {
      const features = resolveFeatures("full");

      expect(features.auth).toBe(true);
      expect(features.predictions).toBe(true);
      expect(features.education).toBe(true);
      expect(features.adminRoutes).toBe(true);
      expect(features.errorCatalog).toBe(true);
      expect(features.versionedAlias).toBe(true);
      expect(features.platformStats).toBe(false);
      expect(features.globalApiRateLimit).toBe(false);
    });

    it("disables full-only surfaces in hackathon mode", () => {
      const features = resolveFeatures("hackathon");

      expect(features.auth).toBe(true);
      expect(features.predictions).toBe(false);
      expect(features.education).toBe(false);
      expect(features.adminRoutes).toBe(false);
      expect(features.corsDiagnostics).toBe(false);
      expect(features.errorCatalog).toBe(false);
      expect(features.versionedAlias).toBe(false);
      expect(features.platformStats).toBe(true);
      expect(features.globalApiRateLimit).toBe(true);
    });

    it("enables corsDiagnostics in hackathon mode via override", () => {
      const features = resolveFeatures("hackathon", { corsDiagnostics: true });

      expect(features.corsDiagnostics).toBe(true);
      expect(features.adminRoutes).toBe(false);
    });

    it("lets an explicit override win over the mode default", () => {
      expect(resolveFeatures("hackathon", { auth: false }).auth).toBe(false);
      expect(resolveFeatures("full", { adminRoutes: false }).adminRoutes).toBe(false);
    });
  });

  describe("flags actually gate their routes", () => {
    it("omits auth routes when auth is off", () => {
      const routes = pathsOf(createApp({ mode: "full", features: { auth: false } }));

      expect(routes.has("POST /api/auth/challenge")).toBe(false);
      expect(routes.has("GET /api/user/profile")).toBe(true);
    });

    it("includes auth routes on the hackathon app by default", () => {
      const routes = pathsOf(createApp({ mode: "hackathon" }));

      expect(routes.has("POST /api/auth/challenge")).toBe(true);
      expect(routes.has("POST /api/auth/connect")).toBe(true);
      expect(routes.has("POST /api/auth/verify")).toBe(true);
    });

    it("omits every admin surface when adminRoutes is off", () => {
      const routes = pathsOf(
        createApp({ mode: "full", features: { adminRoutes: false } }),
      );

      expect(routes.has("GET /api/admin/metrics/rate-limits")).toBe(false);
      // corsDiagnostics is independently gated; it may still be mounted.
      expect(routes.has("GET /api/admin/dead-letter")).toBe(false);
    });

    it("mounts cors-diagnostics independently when corsDiagnostics flag is on", () => {
      const routes = pathsOf(
        createApp({ mode: "full", features: { adminRoutes: false, corsDiagnostics: true } }),
      );

      expect(routes.has("GET /api/admin/cors-diagnostics")).toBe(true);
      expect(routes.has("GET /api/admin/metrics/rate-limits")).toBe(false);
    });

    it("omits prediction routes when predictions is off", () => {
      const routes = pathsOf(
        createApp({ mode: "full", features: { predictions: false } }),
      );

      expect(routes.has("POST /api/predictions/submit")).toBe(false);
    });

    it("omits the education surface when education is off", () => {
      const routes = pathsOf(
        createApp({ mode: "full", features: { education: false } }),
      );

      expect(routes.has("GET /api/education/guides")).toBe(false);
    });

    it("omits the error catalog when errorCatalog is off", () => {
      const routes = pathsOf(
        createApp({ mode: "full", features: { errorCatalog: false } }),
      );

      expect(routes.has("GET /api/errors")).toBe(false);
    });

    it("omits platform stats when platformStats is off", () => {
      const routes = pathsOf(
        createApp({ mode: "hackathon", features: { platformStats: false } }),
      );

      expect(routes.has("GET /api/stats")).toBe(false);
    });

    it("omits the root banner when rootBanner is off", () => {
      const routes = pathsOf(
        createApp({ mode: "full", features: { rootBanner: false } }),
      );

      expect(routes.has("GET /")).toBe(false);
    });

    it("omits the legacy price endpoint when legacyPriceEndpoint is off", () => {
      const routes = pathsOf(
        createApp({ mode: "full", features: { legacyPriceEndpoint: false } }),
      );

      expect(routes.has("GET /api/price")).toBe(false);
      expect(routes.has("GET /api/prices")).toBe(true);
    });

    it("omits chat and notifications when multiplayerSocial is off", () => {
      const routes = pathsOf(
        createApp({ mode: "full", features: { multiplayerSocial: false } }),
      );

      expect(routes.has("GET /api/chat/history")).toBe(false);
      expect(routes.has("GET /api/notifications")).toBe(false);
    });
  });

  describe("versioned alias", () => {
    it("mirrors the unversioned routes when versionedAlias is on", () => {
      const routes = pathsOf(createApp({ mode: "full" }));

      expect(routes.has("GET /api/user/profile")).toBe(true);
      expect(routes.has("GET /api/v1/user/profile")).toBe(true);
    });

    it("drops the /api/v1 tree when versionedAlias is off", () => {
      const routes = [...pathsOf(createApp({ mode: "full", features: { versionedAlias: false } }))];

      expect(routes.some((key) => key.includes("/api/v1/"))).toBe(false);
      expect(routes).toContain("GET /api/user/profile");
    });

    it("keeps the alias a true mirror when a flag removes routes", () => {
      const routes = [
        ...pathsOf(createApp({ mode: "full", features: { auth: false } })),
      ];

      expect(routes.some((key) => key.startsWith("POST /api/v1/auth"))).toBe(false);
    });
  });

  describe("shared surfaces stay shared", () => {
    const full = pathsOf(createApp({ mode: "full" }));
    const hackathon = pathsOf(createApp({ mode: "hackathon" }));

    it.each([
      "POST /api/auth/challenge",
      "POST /api/auth/connect",
      "POST /api/auth/verify",
      "GET /api/user/profile",
      "GET /api/prices",
      "POST /api/bets/up-down",
      "POST /api/bets/precision",
      "GET /api/tournaments",
      "GET /api/leaderboard",
    ])("serves %s from both entrypoints", (route) => {
      expect(full.has(route)).toBe(true);
      expect(hackathon.has(route)).toBe(true);
    });
  });
});
