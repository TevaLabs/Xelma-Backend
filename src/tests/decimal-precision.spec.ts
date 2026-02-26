import {
  toDecimal,
  toNumber,
  decAdd,
  decSub,
  decMul,
  decDiv,
  decGt,
  decLt,
  decEq,
  decFixed,
} from "../utils/decimal.util";
import { Decimal } from "@prisma/client/runtime/library";

describe("Decimal Utility Functions", () => {
  describe("toDecimal", () => {
    it("converts a number to Decimal", () => {
      const d = toDecimal(1.23);
      expect(d).toBeInstanceOf(Decimal);
      expect(d.toNumber()).toBeCloseTo(1.23);
    });

    it("converts a string to Decimal", () => {
      const d = toDecimal("99.99999999");
      expect(d).toBeInstanceOf(Decimal);
      expect(d.toString()).toBe("99.99999999");
    });

    it("returns the same Decimal instance", () => {
      const original = new Decimal("5.5");
      const d = toDecimal(original);
      expect(d).toBe(original);
    });
  });

  describe("toNumber", () => {
    it("returns 0 for null", () => {
      expect(toNumber(null)).toBe(0);
    });

    it("returns 0 for undefined", () => {
      expect(toNumber(undefined)).toBe(0);
    });

    it("passes through plain number", () => {
      expect(toNumber(42)).toBe(42);
    });

    it("converts Decimal to number", () => {
      expect(toNumber(new Decimal("3.14"))).toBeCloseTo(3.14);
    });
  });

  describe("Arithmetic operations", () => {
    it("decAdd sums correctly", () => {
      const result = decAdd(0.1, 0.2);
      // Float: 0.1 + 0.2 = 0.30000000000000004; Decimal is exact
      expect(result.toString()).toBe("0.3");
    });

    it("decSub subtracts correctly", () => {
      const result = decSub(1.0, 0.7);
      expect(result.toString()).toBe("0.3");
    });

    it("decMul multiplies correctly", () => {
      const result = decMul(3, 0.1);
      expect(result.toString()).toBe("0.3");
    });

    it("decDiv divides correctly", () => {
      const result = decDiv(1, 3);
      // Decimal division should be high precision
      expect(result.toNumber()).toBeCloseTo(0.33333333, 6);
    });
  });

  describe("Comparison operations", () => {
    it("decGt returns true when a > b", () => {
      expect(decGt(1.5, 1.4)).toBe(true);
      expect(decGt(1.4, 1.5)).toBe(false);
      expect(decGt(1.5, 1.5)).toBe(false);
    });

    it("decLt returns true when a < b", () => {
      expect(decLt(1.4, 1.5)).toBe(true);
      expect(decLt(1.5, 1.4)).toBe(false);
    });

    it("decEq returns true when equal", () => {
      expect(decEq(1.5, 1.5)).toBe(true);
      expect(decEq(new Decimal("0.3"), decAdd(0.1, 0.2))).toBe(true);
    });
  });

  describe("decFixed", () => {
    it("formats to 2 decimal places by default", () => {
      expect(decFixed(3.14159)).toBe("3.14");
    });

    it("formats to specified places", () => {
      expect(decFixed(3.14159, 4)).toBe("3.1416");
    });
  });
});

describe("Monetary Precision Scenarios", () => {
  it("pool distribution is deterministic for fractional bets", () => {
    // Simulate payout: 3 winners put in 0.1, 0.2, 0.3 against losing pool of 1.5
    const winningPool = decAdd(decAdd(0.1, 0.2), 0.3); // 0.6
    const losingPool = toDecimal(1.5);

    const payout1 = decAdd(
      toDecimal(0.1),
      decMul(decDiv(toDecimal(0.1), winningPool), losingPool),
    );
    const payout2 = decAdd(
      toDecimal(0.2),
      decMul(decDiv(toDecimal(0.2), winningPool), losingPool),
    );
    const payout3 = decAdd(
      toDecimal(0.3),
      decMul(decDiv(toDecimal(0.3), winningPool), losingPool),
    );

    // Total payouts should equal total pool (0.6 + 1.5 = 2.1)
    const totalPayouts = decAdd(decAdd(payout1, payout2), payout3);
    expect(totalPayouts.toNumber()).toBeCloseTo(2.1, 8);
  });

  it("balance deduction and refund round-trips cleanly", () => {
    const startBalance = toDecimal(1000);
    const betAmount = toDecimal("33.33333333");

    const afterBet = decSub(startBalance, betAmount);
    const afterRefund = decAdd(afterBet, betAmount);

    expect(decEq(afterRefund, startBalance)).toBe(true);
  });

  it("avoids classic 0.1 + 0.2 !== 0.3 float bug", () => {
    // JavaScript: 0.1 + 0.2 = 0.30000000000000004
    expect(0.1 + 0.2).not.toBe(0.3);

    // Decimal: exact
    const result = decAdd(0.1, 0.2);
    expect(decEq(result, 0.3)).toBe(true);
  });

  it("proportional payout is deterministic across runs", () => {
    const betAmount = toDecimal("7.77777777");
    const winningPool = toDecimal("100.00000000");
    const losingPool = toDecimal("200.00000000");

    const share = decMul(decDiv(betAmount, winningPool), losingPool);
    const payout = decAdd(betAmount, share);

    // Re-run same calculation
    const share2 = decMul(decDiv(betAmount, winningPool), losingPool);
    const payout2 = decAdd(betAmount, share2);

    expect(decEq(payout, payout2)).toBe(true);
    expect(payout.toString()).toBe(payout2.toString());
  });

  it("handles very small monetary amounts without drift", () => {
    const tiny = toDecimal("0.00000001");
    const sum = decMul(tiny, 100000000); // should be 1.0
    expect(decEq(sum, 1)).toBe(true);
  });
});
