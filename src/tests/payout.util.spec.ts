import { describe, expect, it } from '@jest/globals';
import { Decimal } from '@prisma/client/runtime/library';

import {
  STROOPS_PER_XLM,
  stroopsToXlm,
  xlmToStroops,
  calculatePayout,
} from '../utils/payout.util';
import { toDecimal } from '../utils/decimal.util';

describe('payout.util', () => {
  it('converts stroops to XLM', () => {
    expect(STROOPS_PER_XLM).toBe(10_000_000);
    expect(stroopsToXlm(BigInt(50_000_000))).toBe(5);
    expect(stroopsToXlm(0)).toBe(0);
  });

  it('converts XLM to stroops', () => {
    expect(xlmToStroops(5)).toBe(BigInt(50_000_000));
    expect(xlmToStroops('1.5')).toBe(BigInt(15_000_000));
  });

  it('round-trips XLM through stroops', () => {
    expect(stroopsToXlm(xlmToStroops(7.25))).toBe(7.25);
  });

  it('returns the stake unchanged when the winning pool is zero', () => {
    const stake = new Decimal('10');
    expect(calculatePayout(stake, new Decimal(0), new Decimal('50')).toString()).toBe('10');
  });

  it('computes stake plus the proportional losing pool', () => {
    expect(calculatePayout(toDecimal(10), toDecimal(100), toDecimal(50)).toString()).toBe('15');
  });

  it('preserves Decimal precision for fractional stakes', () => {
    expect(calculatePayout(toDecimal('0.5'), toDecimal(2), toDecimal(1)).toString()).toBe('0.75');
  });
});
