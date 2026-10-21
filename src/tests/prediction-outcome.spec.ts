/**
 * Tests for src/utils/prediction-outcome.util.ts
 *
 * The rule implemented here is shared by the incremental UserStats writer
 * (`leaderboard.service.ts` → `updateUserStatsForRound`) and the full rebuild
 * (`stats.service.ts` → `rebuildUserStats`). It is tested on its own so a
 * change to one of the two writers cannot silently disagree with the other.
 *
 * Run:  npx jest src/tests/prediction-outcome.spec.ts
 */

import {
    isPredictionCorrect,
    isRoundSettled,
} from "../utils/prediction-outcome.util";
import { toDecimal } from "../utils/decimal.util";

describe("isRoundSettled", () => {
    it("is true when the round recorded an end price", () => {
        expect(isRoundSettled({ endPrice: toDecimal("1.5") })).toBe(true);
    });

    it("is false when the round has no end price", () => {
        expect(isRoundSettled({ endPrice: null })).toBe(false);
        expect(isRoundSettled(null)).toBe(false);
        expect(isRoundSettled(undefined)).toBe(false);
    });
});

describe("isPredictionCorrect — UP_DOWN", () => {
    const round = (start: string, end: string) => ({
        mode: "UP_DOWN",
        startPrice: toDecimal(start),
        endPrice: toDecimal(end),
    });

    it("wins when UP was called and the price rose", () => {
        expect(isPredictionCorrect({ side: "UP" }, round("1", "2"))).toBe(true);
    });

    it("wins when DOWN was called and the price fell", () => {
        expect(isPredictionCorrect({ side: "DOWN" }, round("2", "1"))).toBe(true);
    });

    it("loses when UP was called and the price fell", () => {
        expect(isPredictionCorrect({ side: "UP" }, round("2", "1"))).toBe(false);
    });

    it("loses when DOWN was called and the price rose", () => {
        expect(isPredictionCorrect({ side: "DOWN" }, round("1", "2"))).toBe(false);
    });

    it("treats an unchanged price as a loss for UP", () => {
        expect(isPredictionCorrect({ side: "UP" }, round("1", "1"))).toBe(false);
        expect(isPredictionCorrect({ side: "DOWN" }, round("1", "1"))).toBe(true);
    });

    it("is never correct without a start price", () => {
        expect(
            isPredictionCorrect(
                { side: "UP" },
                { mode: "UP_DOWN", startPrice: null, endPrice: toDecimal("2") },
            ),
        ).toBe(false);
    });

    it("is never correct without an end price", () => {
        expect(
            isPredictionCorrect(
                { side: "UP" },
                { mode: "UP_DOWN", startPrice: toDecimal("1"), endPrice: null },
            ),
        ).toBe(false);
    });

    it("is never correct without a side", () => {
        expect(isPredictionCorrect({ side: null }, round("1", "2"))).toBe(false);
    });
});

describe("isPredictionCorrect — LEGENDS", () => {
    const round = (start: string, end: string) => ({
        mode: "LEGENDS",
        startPrice: toDecimal(start),
        endPrice: toDecimal(end),
    });

    it("wins when the end price is inside the predicted range", () => {
        expect(
            isPredictionCorrect({ priceRange: { min: 1, max: 3 } }, round("1", "2")),
        ).toBe(true);
    });

    it("wins on the inclusive bounds of the predicted range", () => {
        expect(
            isPredictionCorrect({ priceRange: { min: 1, max: 3 } }, round("1", "1")),
        ).toBe(true);
        expect(
            isPredictionCorrect({ priceRange: { min: 1, max: 3 } }, round("1", "3")),
        ).toBe(true);
    });

    it("loses when the end price is outside the predicted range", () => {
        expect(
            isPredictionCorrect({ priceRange: { min: 1, max: 3 } }, round("1", "4")),
        ).toBe(false);
    });

    it("loses without a predicted range", () => {
        expect(isPredictionCorrect({ priceRange: null }, round("1", "2"))).toBe(false);
    });
});
