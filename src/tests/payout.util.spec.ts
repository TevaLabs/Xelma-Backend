import { describe, it, expect } from '@jest/globals';
import { Decimal } from '@prisma/client/runtime/library';
import { calculatePayout } from '../utils/payout.util';

describe('payout.util.calculatePayout', () => {
  it('returns the stake unchanged when the winning pool is zero', () => {
    const stake = new Decimal('10');
    const payout = calculatePayout(stake, new Decimal(0), new Decimal('50'));
    expect(payout.toString()).toBe(stake.toString());
  });

  it('computes stake + (stake / winningPool) * losingPool', () => {
    // stake=10, winningPool=100, losingPool=50 -> 10 + (10/100)*50 = 15
    const payout = calculatePayout(new Decimal('10'), new Decimal('100'), new Decimal('50'));
    expect(payout.toString()).toBe('15');
  });

  it('returns exactly the stake when the losing pool is zero', () => {
    const payout = calculatePayout(new Decimal('20'), new Decimal('100'), new Decimal(0));
    expect(payout.toString()).toBe('20');
  });

  it('preserves Decimal precision for fractional stakes', () => {
    const payout = calculatePayout(new Decimal('0.5'), new Decimal('2'), new Decimal('1'));
    // 0.5 + (0.5/2)*1 = 0.5 + 0.25 = 0.75, exactly — no native float drift.
    expect(payout.toString()).toBe('0.75');
  });
});

import { describe, it, expect } from "@jest/globals";
import {
  STROOPS_PER_XLM,
  stroopsToXlm,
  xlmToStroops,
  calculatePayout,
} from "../utils/payout.util";
import { toDecimal } from "../utils/decimal.util";

describe("payout.util", () => {
  it("converts stroops to XLM", () => {
    expect(STROOPS_PER_XLM).toBe(10_000_000);
    expect(stroopsToXlm(BigInt(50_000_000))).toBe(5);
    expect(stroopsToXlm(0)).toBe(0);
  });

  it("converts XLM to stroops", () => {
    expect(xlmToStroops(5)).toBe(BigInt(50_000_000));
    expect(xlmToStroops("1.5")).toBe(BigInt(15_000_000));
  });

  it("round-trips XLM through stroops", () => {
    expect(stroopsToXlm(xlmToStroops(7.25))).toBe(7.25);
  });

  it("calculatePayout still shares losing pool correctly", () => {
    const payout = calculatePayout(
      toDecimal(10),
      toDecimal(50),
      toDecimal(100)
    );
    expect(payout.toNumber()).toBe(30);
  });
});
