import { Decimal } from '@prisma/client/runtime/library';
import { decAdd, decDiv, decMul } from './decimal.util';

/**
 * Calculates the payout for a correct prediction: stake + (stake / winningPool) * losingPool
 */
export function calculatePayout(
  stake: Decimal,
  winningPool: Decimal,
  losingPool: Decimal,
): Decimal {
  if (winningPool.isZero()) {
    return stake;
  }
  // stake + (stake / winningPool) * losingPool
  const shareOfLosingPool = decMul(decDiv(stake, winningPool), losingPool);
  return decAdd(stake, shareOfLosingPool);
}
