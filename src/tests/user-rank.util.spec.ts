/**
 * Unit tests for the shared XP / rank helpers (Issue #514).
 *
 * The helpers were extracted from src/routes/user.ts and
 * src/routes/user.routes.ts to give the rank logic a single source of truth.
 * These tests pin down both the math and every rank-tier boundary so no future
 * edit to the formula or thresholds can silently change user-facing ranks.
 */
import { describe, it, expect } from "@jest/globals";
import {
  computeXp,
  computeRankTitle,
  XP_PER_WIN,
  XP_PER_STREAK,
  RANK_THRESHOLDS,
  ROOKIE_RANK_TITLE,
} from "../utils/user-rank.util";

describe("computeXp", () => {
  it("returns 0 when there are no wins and no streak", () => {
    expect(computeXp(0, 0)).toBe(0);
  });

  it("uses the formula totalWins * 100 + bestStreak * 50", () => {
    expect(computeXp(1, 0)).toBe(100);
    expect(computeXp(0, 1)).toBe(50);
    expect(computeXp(10, 3)).toBe(1000 + 150);
  });

  it("matches the documented per-unit constants", () => {
    expect(computeXp(3, 4)).toBe(3 * XP_PER_WIN + 4 * XP_PER_STREAK);
  });

  it("handles zero streak / zero wins independently", () => {
    expect(computeXp(0, 7)).toBe(7 * XP_PER_STREAK);
    expect(computeXp(7, 0)).toBe(7 * XP_PER_WIN);
  });

  it("is purely a function of its inputs (no shared state)", () => {
    const a = computeXp(5, 2);
    const b = computeXp(5, 2);
    expect(a).toBe(b);
  });

  it("stays integer for whole-number stats (no float drift)", () => {
    const xp = computeXp(123, 45);
    expect(Number.isInteger(xp)).toBe(true);
    expect(xp).toBe(123 * 100 + 45 * 50);
  });
});

describe("computeRankTitle", () => {
  it("returns Rookie below the first threshold", () => {
    expect(computeRankTitle(0)).toBe(ROOKIE_RANK_TITLE);
    expect(computeRankTitle(499)).toBe(ROOKIE_RANK_TITLE);
  });

  it("returns Rookie for negative XP (defensive)", () => {
    expect(computeRankTitle(-5)).toBe(ROOKIE_RANK_TITLE);
    expect(computeRankTitle(-1000)).toBe(ROOKIE_RANK_TITLE);
  });

  it.each([
    [500, "Bronze"],
    [1499, "Bronze"],
    [1500, "Silver"],
    [2999, "Silver"],
    [3000, "Gold"],
    [4999, "Gold"],
    [5000, "Platinum"],
    [9999, "Platinum"],
    [10000, "Diamond"],
    [20000, "Diamond"],
  ])("maps xp=%i to %s", (xp, title) => {
    expect(computeRankTitle(xp)).toBe(title);
  });

  it("applies inclusivity at every boundary (xp === minXp qualifies)", () => {
    for (const { minXp, title } of RANK_THRESHOLDS) {
      expect(computeRankTitle(minXp)).toBe(title);
    }
  });

  it("awards the highest tier without an upper cap", () => {
    expect(computeRankTitle(1_000_000)).toBe("Diamond");
  });

  it("thresholds are ordered from highest to lowest requirement", () => {
    const mins = RANK_THRESHOLDS.map((t) => t.minXp);
    const sorted = [...mins].sort((a, b) => b - a);
    expect(mins).toEqual(sorted);
  });
});

describe("combined XP -> rank flow", () => {
  it("produces the ranks used in route responses", () => {
    // 6 wins + 4 streak = 600 + 200 = 800 XP -> Bronze
    expect(computeRankTitle(computeXp(6, 4))).toBe("Bronze");
    // 20 wins + 10 streak = 2000 + 500 = 2500 XP -> Silver (>=1500, <3000)
    expect(computeRankTitle(computeXp(20, 10))).toBe("Silver");
  });
});