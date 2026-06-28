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
});
