/**
 * Regression coverage for #196 — the unified error code catalog.
 *
 * If a new ErrorCode is added without a matching ERROR_CATALOG entry,
 * the test fails so the catalog cannot silently drift out of sync
 * with the enum API clients depend on. Also pins per-code HTTP status
 * and ensures every entry has a description (so API consumers always
 * have something actionable).
 */
import { describe, it, expect } from "@jest/globals";

import { ErrorCode, ERROR_CATALOG } from "../utils/errors";

describe("ERROR_CATALOG", () => {
  it("covers every ErrorCode enum value exactly once", () => {
    const enumValues = Object.values(ErrorCode);
    const catalogCodes = ERROR_CATALOG.map((entry) => entry.code);

    expect(new Set(catalogCodes).size).toBe(catalogCodes.length);
    expect(new Set(catalogCodes)).toEqual(new Set(enumValues));
  });

  it("pins every entry to a sensible HTTP status (4xx or 5xx)", () => {
    for (const entry of ERROR_CATALOG) {
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.status).toBeLessThan(600);
    }
  });

  it("never ships a blank description", () => {
    for (const entry of ERROR_CATALOG) {
      expect(entry.description.length).toBeGreaterThan(20);
    }
  });

  it("uses status 401 for every challenge-flow error", () => {
    const challengeCodes = [
      ErrorCode.INVALID_CHALLENGE,
      ErrorCode.CHALLENGE_EXPIRED,
      ErrorCode.CHALLENGE_USED,
      ErrorCode.INVALID_SIGNATURE,
    ];
    for (const code of challengeCodes) {
      const entry = ERROR_CATALOG.find((e) => e.code === code);
      expect(entry?.status).toBe(401);
    }
  });
});
