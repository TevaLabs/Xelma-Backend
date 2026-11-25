import { describe, expect, it } from "@jest/globals";
import request from "supertest";

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

import { createApp, AppMode } from "../app-factory";

/**
 * Smoke test for response compression (#699).
 *
 * `/api-docs.json` is used as the large JSON GET: it needs no database and is
 * far above the middleware's 1 kb threshold in both modes. (`/api/health` is
 * a small payload that depends on live services, so it is not a stable probe
 * for this.)
 */
describe.each<AppMode>(["full", "hackathon"])(
  "gzip compression — %s app",
  (mode) => {
    const app = createApp({ mode });

    it("gzips a large JSON GET when the client accepts gzip", async () => {
      const res = await request(app)
        .get("/api-docs.json")
        .set("Accept-Encoding", "gzip");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(res.headers["content-encoding"]).toBe("gzip");
      expect(res.headers["vary"]).toMatch(/Accept-Encoding/i);
      // supertest transparently inflates the body, so a parsed spec proves
      // the gzip stream is valid, not just that the header was set.
      expect(res.body.openapi).toBeDefined();
      expect(res.body.paths).toBeDefined();
    });

    it("sends the same JSON uncompressed when the client does not accept gzip", async () => {
      const res = await request(app)
        .get("/api-docs.json")
        .set("Accept-Encoding", "identity");

      expect(res.status).toBe(200);
      expect(res.headers["content-encoding"]).toBeUndefined();
      expect(res.body.paths).toBeDefined();
    });

    it("leaves responses below the size threshold uncompressed", async () => {
      const res = await request(app)
        .get("/api/this-route-does-not-exist")
        .set("Accept-Encoding", "gzip");

      expect(res.status).toBe(404);
      expect(res.headers["content-encoding"]).toBeUndefined();
    });
  },
);
