/**
 * Fixtures for the hackathon mock tables (`hackathon_rounds`,
 * `hackathon_users`, `hackathon_bets`).
 *
 * The integration database is shared by every spec file in the project, and
 * the hackathon app serves its rounds straight from `hackathon_rounds`. The
 * demo rounds therefore have to be seeded by the specs themselves — the CI job
 * starts an empty PostgreSQL instance and never runs `prisma db seed`.
 *
 * Two rules keep the shared database deterministic:
 *
 * 1. The demo rounds always use the same ids, so every suite that needs a
 *    round can rely on them existing without creating duplicates.
 * 2. Suites that assert on mutable pool balances use their own round ids
 *    (see `seedDedicatedRound`) so parallel workers cannot corrupt each
 *    other's expectations.
 */
import { prisma } from '../../lib/prisma';

export interface HackathonRoundFixture {
  id: string;
  asset: string;
  mode: string;
  status: string;
  startPrice: number;
  poolUp: number | null;
  poolDown: number | null;
  totalPool: number | null;
  predictionCount: number | null;
}

/** The three demo rounds the hackathon app exposes. */
export const HACKATHON_ROUND_FIXTURES: HackathonRoundFixture[] = [
  {
    id: 'btc-updown-live',
    asset: 'BTC',
    mode: 'updown',
    status: 'live',
    startPrice: 60000,
    poolUp: 0,
    poolDown: 0,
    totalPool: null,
    predictionCount: null,
  },
  {
    id: 'eth-precision-live',
    asset: 'ETH',
    mode: 'precision',
    status: 'live',
    startPrice: 3000,
    poolUp: null,
    poolDown: null,
    totalPool: 0,
    predictionCount: 0,
  },
  {
    id: 'xlm-updown-new',
    asset: 'XLM',
    mode: 'updown',
    status: 'new',
    startPrice: 0.29,
    poolUp: 0,
    poolDown: 0,
    totalPool: null,
    predictionCount: null,
  },
];

function closesAt(): string {
  return new Date(Date.now() + 300_000).toISOString();
}

/**
 * Ensure the demo rounds exist. Existing rows keep their pool balances, so
 * a suite that asserts on deltas still sees a stable starting point.
 */
export async function seedHackathonRounds(): Promise<void> {
  for (const round of HACKATHON_ROUND_FIXTURES) {
    await prisma.mockRound.upsert({
      where: { id: round.id },
      create: { ...round, closesAt: closesAt() },
      update: { status: round.status, closesAt: closesAt() },
    });
  }
}

/**
 * Create a round owned by a single spec file. Use it whenever the test
 * asserts on pool balances, so concurrent suites cannot change them.
 */
export async function seedDedicatedRound(
  round: HackathonRoundFixture,
): Promise<void> {
  await prisma.mockRound.upsert({
    where: { id: round.id },
    create: { ...round, closesAt: closesAt() },
    update: {
      asset: round.asset,
      mode: round.mode,
      status: round.status,
      startPrice: round.startPrice,
      poolUp: round.poolUp,
      poolDown: round.poolDown,
      totalPool: round.totalPool,
      predictionCount: round.predictionCount,
      closesAt: closesAt(),
    },
  });
}

/** Remove a round created by `seedDedicatedRound`. */
export async function removeDedicatedRound(id: string): Promise<void> {
  await prisma.mockBet.deleteMany({ where: { roundId: id } });
  await prisma.mockRound.deleteMany({ where: { id } });
}
