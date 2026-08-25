import { describe, expect, it } from "@jest/globals";

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
  validateVendoredBindingsSync: jest.fn(() => ({ ok: true })),
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

const mainRoutes = extractRoutes(createMainApp());
const hackathonRoutes = extractRoutes(createHackathonApp());

describe("route parity", () => {
  it("inventories at least the documented core routes from both apps", () => {
    expect(mainRoutes.length).toBeGreaterThan(20);
    expect(hackathonRoutes.length).toBeGreaterThan(3);
  });

  it("mirrors every /api route under the /api/v1 alias", () => {
    const { legacyOnly, versionedOnly } = getVersionedAliasDrift(mainRoutes);

    expect({ legacyOnly, versionedOnly }).toEqual({
      legacyOnly: [],
      versionedOnly: [],
    });
  });

  it("has no route present in only one app outside the allowlist", () => {
    const { mainOnly, hackathonOnly } = getCrossAppDrift(
      mainRoutes,
      hackathonRoutes,
    );

    expect({ mainOnly, hackathonOnly }).toEqual({
      mainOnly: [],
      hackathonOnly: [],
    });
  });

  it("keeps the parity allowlist free of stale entries", () => {
    const { staleAllowlist } = getCrossAppDrift(mainRoutes, hackathonRoutes);

    expect(staleAllowlist).toEqual([]);
  });

  it("has no duplicate allowlist entries", () => {
    const keys = PARITY_ALLOWLIST.map(routeKey);

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
