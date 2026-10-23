import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "production-readiness-scorecard.js");

// Plain Node script outside src/, so it is required rather than imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { hasRefreshRoute, metricsRouteIsProtected } = require(SCRIPT) as {
  hasRefreshRoute: (authRoutesSource: string | null) => boolean;
  metricsRouteIsProtected: (
    metricsRoutesSource: string | null,
    appFactorySource: string | null,
  ) => boolean;
};

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const GUARDED_ROUTER = `
  import { requirePublicMetricsAuth } from '../middleware/auth.middleware';
  router.get('/', requirePublicMetricsAuth, async (_req, res) => { res.end(''); });
`;
const FACTORY = `
  import metricsRoutes from './routes/metrics.routes';
  app.use('/metrics', metricsRoutes);
`;

describe("production-readiness scorecard heuristics (#632)", () => {
  describe("JWT refresh route", () => {
    it("recognises the real auth router", () => {
      expect(hasRefreshRoute(read("src/routes/auth.routes.ts"))).toBe(true);
    });

    it("fails when no refresh route is registered", () => {
      const source = `router.post("/connect", authRateLimiter, connectHandler);`;
      expect(hasRefreshRoute(source)).toBe(false);
      expect(hasRefreshRoute(null)).toBe(false);
    });

    it("is not satisfied by unrelated mentions of refresh", () => {
      const source = `
        /**
         * @swagger
         * /api/auth/refresh:
         *   post:
         *     summary: Refresh JWT access token
         */
        // router.post("/refresh", authRateLimiter, handler);
        const refreshLeaderboardCache = () => {};
        router.post("/connect", authRateLimiter, connectHandler);
      `;
      expect(hasRefreshRoute(source)).toBe(false);
    });
  });

  describe("/metrics protection", () => {
    it("recognises the real metrics router and app factory", () => {
      expect(
        metricsRouteIsProtected(
          read("src/routes/metrics.routes.ts"),
          read("src/app-factory.ts"),
        ),
      ).toBe(true);
    });

    it("passes for a guarded scrape handler mounted through the factory", () => {
      expect(metricsRouteIsProtected(GUARDED_ROUTER, FACTORY)).toBe(true);
    });

    it("fails when the scrape handler has no guard middleware", () => {
      const open = `
        // Requires auth (see requirePublicMetricsAuth)
        import { requirePublicMetricsAuth } from '../middleware/auth.middleware';
        router.get('/', async (_req, res) => { res.end(''); });
      `;
      expect(metricsRouteIsProtected(open, FACTORY)).toBe(false);
    });

    it("fails when only a sibling route is guarded", () => {
      const siblingOnly = `
        router.get('/', async (_req, res) => { res.end(''); });
        router.get('/readiness', requireAdmin, async (_req, res) => { res.end(''); });
      `;
      expect(metricsRouteIsProtected(siblingOnly, FACTORY)).toBe(false);
    });

    it("fails when the factory mounts an inline /metrics handler", () => {
      const inline = `
        import metricsRoutes from './routes/metrics.routes';
        app.use('/metrics', metricsRoutes);
        app.get('/metrics', (_req, res) => res.end(registry.metrics()));
      `;
      expect(metricsRouteIsProtected(GUARDED_ROUTER, inline)).toBe(false);
    });

    it("fails when sources are missing", () => {
      expect(metricsRouteIsProtected(null, FACTORY)).toBe(false);
      expect(metricsRouteIsProtected(GUARDED_ROUTER, null)).toBe(false);
    });
  });

  describe("npm run scorecard", () => {
    it("reports the three production checks individually and exits 0", () => {
      const result = spawnSync(process.execPath, [SCRIPT], {
        cwd: ROOT,
        encoding: "utf8",
      });

      expect(result.stdout).toMatch(
        /PASS\s+Architecture documentation exists \(docs\/architecture\.md\) \[required\]/,
      );
      expect(result.stdout).toMatch(
        /PASS\s+Migrations are free of unapproved DROP risk \[required\]/,
      );
      expect(result.stdout).toMatch(
        /PASS\s+Auth routes expose a JWT refresh endpoint \[required\]/,
      );
      expect(result.stdout).toMatch(
        /PASS\s+\/metrics is protected by an auth guard \[required\]/,
      );
      expect(result.status).toBe(0);
    });
  });
});
