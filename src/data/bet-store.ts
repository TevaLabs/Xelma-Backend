import { toDecimal, toNumber } from '../utils/decimal.util';
import { prisma } from '../lib/prisma';
import config from '../config';
import logger from '../utils/logger';

export type BetStatus = 'STUB' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';

export interface StoredBet {
  id: string;
  address: string;
  amount: number;
  side?: 'UP' | 'DOWN';
  predictedPrice?: number;
  mode: 'updown' | 'precision';
  /** Undefined when no round was active at the time the bet was recorded. */
  roundId?: string;
  timestamp: string;

  // --- on-chain reconciliation ---
  status: BetStatus;
  /** Set once the bet is CONFIRMED (or reconciled from STUB). */
  txHash?: string;
  /** Set when the bet is handed to Soroban. */
  submittedAt?: string;
  confirmedAt?: string;
  failedAt?: string;
  failureReason?: string;
}

export interface BetQuery {
  address?: string;
  roundId?: string;
  status?: BetStatus;
}

export interface StoredRound {
  id: string;
  asset: string;
  mode: 'updown' | 'precision';
  status: 'live' | 'new';
  startPrice: number;
  poolUp: number;
  poolDown: number;
  totalPool: number;
  predictionCount: number;
  closesAt: string;
}

export type BetStoreKind = 'memory' | 'postgres';

/**
 * Backend contract for the bet store (Issue #519).
 *
 * Two implementations exist:
 *  - {@link InMemoryBetStore} — process-local Maps. Used for true mock mode
 *    (`DATA_STORE=memory`, auto-derived from `DATA_MODE=mock`). Bets do NOT
 *    survive a restart.
 *  - {@link PrismaBetStore} — bets persisted in the `BetRecord` table. Used
 *    for database mode (`DATA_STORE=postgres`, the `DATA_MODE=live` default).
 *    Bets survive restarts and are shared across instances.
 *
 * Every method is async so both backends expose the same API.
 */
export interface BetStoreBackend {
  readonly kind: BetStoreKind;

  addUpDownBet(
    roundId: string,
    address: string,
    amount: number,
    side: 'UP' | 'DOWN',
    status?: BetStatus,
  ): Promise<StoredBet>;

  addPrecisionBet(
    roundId: string,
    address: string,
    amount: number,
    predictedPrice: number,
    status?: BetStatus,
  ): Promise<StoredBet>;

  /** Mark a bet as handed to Soroban, before the outcome is known. */
  markSubmitted(betId: string): Promise<StoredBet | undefined>;

  /** Attach the on-chain transaction hash and mark the bet CONFIRMED. */
  markConfirmed(betId: string, txHash: string): Promise<StoredBet | undefined>;

  /** Mark an on-chain submission as rejected. */
  markFailed(betId: string, failureReason: string): Promise<StoredBet | undefined>;

  getBet(betId: string): Promise<StoredBet | undefined>;

  /** All bets, newest first, optionally narrowed by address/round/status. */
  getBets(query?: BetQuery): Promise<StoredBet[]>;

  /** Count of bets per reconciliation status, for admin/audit summaries. */
  getReconciliationSummary(): Promise<Record<BetStatus, number>>;

  getTotalBetsCount(): Promise<number>;

  getRounds(): Promise<StoredRound[]>;

  getActiveRound(mode: 'updown' | 'precision'): Promise<StoredRound | undefined>;

  /** Restore seed state. Test-isolation helper. */
  reset(): Promise<void>;
}

const MINUTES_FROM_NOW = (minutes: number): string =>
  new Date(Date.now() + minutes * 60 * 1000).toISOString();

const SEED_ROUNDS: StoredRound[] = [
  {
    id: 'btc-updown-live',
    asset: 'BTC',
    mode: 'updown',
    status: 'live',
    startPrice: 67420,
    poolUp: 2800,
    poolDown: 1400,
    totalPool: 4200,
    predictionCount: 0,
    closesAt: MINUTES_FROM_NOW(3),
  },
  {
    id: 'eth-precision-live',
    asset: 'ETH',
    mode: 'precision',
    status: 'live',
    startPrice: 3241,
    poolUp: 0,
    poolDown: 0,
    totalPool: 1800,
    predictionCount: 22,
    closesAt: MINUTES_FROM_NOW(12),
  },
  {
    id: 'xlm-updown-new',
    asset: 'XLM',
    mode: 'updown',
    status: 'new',
    startPrice: 0.2891,
    poolUp: 200,
    poolDown: 0,
    totalPool: 200,
    predictionCount: 0,
    closesAt: MINUTES_FROM_NOW(20),
  },
];

/**
 * Process-local bet store. Purely in-memory: rounds are seeded and mutated in
 * Maps, bets live in a Map keyed by id. Nothing survives a restart — this is
 * the "true mock mode" fallback (`DATA_STORE=memory`).
 */
class InMemoryBetStore implements BetStoreBackend {
  readonly kind: BetStoreKind = 'memory';

  private rounds: Map<string, StoredRound>;
  private bets: Map<string, StoredBet> = new Map();
  private totalBetsCount = 0;
  private betSequence = 0;

  constructor() {
    this.rounds = new Map(SEED_ROUNDS.map(r => [r.id, { ...r }]));
  }

  private recordBet(
    input: Omit<StoredBet, 'id' | 'timestamp'> & { timestamp?: string },
  ): StoredBet {
    this.betSequence += 1;
    const bet: StoredBet = {
      id: `bet-${this.betSequence}`,
      timestamp: input.timestamp ?? new Date().toISOString(),
      ...input,
    };
    this.bets.set(bet.id, bet);
    this.totalBetsCount += 1;
    return bet;
  }

  async addUpDownBet(
    roundId: string,
    address: string,
    amount: number,
    side: 'UP' | 'DOWN',
    status: BetStatus = 'STUB',
  ): Promise<StoredBet> {
    const round = this.rounds.get(roundId);

    if (round && round.mode === 'updown') {
      if (side === 'UP') round.poolUp += amount;
      else round.poolDown += amount;
      round.totalPool = round.poolUp + round.poolDown;
    }

    return this.recordBet({
      roundId: round && round.mode === 'updown' ? roundId : undefined,
      address,
      amount,
      side,
      mode: 'updown',
      status,
      submittedAt: status === 'SUBMITTED' ? new Date().toISOString() : undefined,
    });
  }

  async addPrecisionBet(
    roundId: string,
    address: string,
    amount: number,
    predictedPrice: number,
    status: BetStatus = 'STUB',
  ): Promise<StoredBet> {
    const round = this.rounds.get(roundId);

    if (round && round.mode === 'precision') {
      round.totalPool += amount;
      round.predictionCount++;
    }

    return this.recordBet({
      roundId: round && round.mode === 'precision' ? roundId : undefined,
      address,
      amount,
      predictedPrice,
      mode: 'precision',
      status,
      submittedAt: status === 'SUBMITTED' ? new Date().toISOString() : undefined,
    });
  }

  /** Mark a bet as handed to Soroban, before the outcome is known. */
  async markSubmitted(betId: string): Promise<StoredBet | undefined> {
    const bet = this.bets.get(betId);
    if (!bet) return undefined;

    bet.status = 'SUBMITTED';
    bet.submittedAt = bet.submittedAt ?? new Date().toISOString();
    return { ...bet };
  }

  /**
   * Attach the on-chain transaction hash and mark the bet CONFIRMED.
   *
   * This is the stub → live upgrade path: a bet recorded as STUB while
   * BET_STUB_MODE was on can be reconciled here once its transaction is
   * known, without losing the original record or its timestamp.
   */
  async markConfirmed(betId: string, txHash: string): Promise<StoredBet | undefined> {
    const bet = this.bets.get(betId);
    if (!bet) return undefined;

    bet.status = 'CONFIRMED';
    bet.txHash = txHash;
    bet.submittedAt = bet.submittedAt ?? new Date().toISOString();
    bet.confirmedAt = new Date().toISOString();
    bet.failedAt = undefined;
    bet.failureReason = undefined;
    return { ...bet };
  }

  /** Mark an on-chain submission as rejected. */
  async markFailed(betId: string, failureReason: string): Promise<StoredBet | undefined> {
    const bet = this.bets.get(betId);
    if (!bet) return undefined;

    bet.status = 'FAILED';
    bet.failedAt = new Date().toISOString();
    bet.failureReason = failureReason;
    return { ...bet };
  }

  async getBet(betId: string): Promise<StoredBet | undefined> {
    const bet = this.bets.get(betId);
    return bet ? { ...bet } : undefined;
  }

  /** All bets, newest first, optionally narrowed by address/round/status. */
  async getBets(query: BetQuery = {}): Promise<StoredBet[]> {
    return Array.from(this.bets.values())
      .filter(bet => {
        if (query.address && bet.address !== query.address) return false;
        if (query.roundId && bet.roundId !== query.roundId) return false;
        if (query.status && bet.status !== query.status) return false;
        return true;
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id))
      .map(bet => ({ ...bet }));
  }

  /** Count of bets per reconciliation status, for admin/audit summaries. */
  async getReconciliationSummary(): Promise<Record<BetStatus, number>> {
    const summary: Record<BetStatus, number> = {
      STUB: 0,
      SUBMITTED: 0,
      CONFIRMED: 0,
      FAILED: 0,
    };
    for (const bet of this.bets.values()) {
      summary[bet.status]++;
    }
    return summary;
  }

  async getRounds(): Promise<StoredRound[]> {
    return Array.from(this.rounds.values());
  }

  async getTotalBetsCount(): Promise<number> {
    return this.totalBetsCount;
  }

  async getActiveRound(mode: 'updown' | 'precision'): Promise<StoredRound | undefined> {
    return Array.from(this.rounds.values()).find(
      r => r.mode === mode && r.status === 'live'
    );
  }

  /** Restore seed state. Test-isolation helper. */
  async reset(): Promise<void> {
    this.rounds = new Map(SEED_ROUNDS.map(r => [r.id, { ...r }]));
    this.bets = new Map();
    this.totalBetsCount = 0;
    this.betSequence = 0;
  }
}

/**
 * Prisma-backed bet store (Issue #519).
 *
 * Bets are written to the `BetRecord` table so they survive process restarts
 * and are visible to every instance sharing the database. Round data stays
 * in-memory (seed/demo state, identical to the memory backend); only the bet
 * audit trail is durable.
 *
 * Bet ids keep the `bet-{n}` shape. The sequence is resumed from the highest
 * existing row on first write, so a restarted process continues numbering
 * where the previous one stopped. (For true multi-writer deployments a
 * database-generated id would be the next step; single-writer restarts are
 * the contract covered here.)
 */
class PrismaBetStore implements BetStoreBackend {
  readonly kind: BetStoreKind = 'postgres';

  private rounds: Map<string, StoredRound>;
  private sequenceInit: Promise<number> | null = null;
  private sequence = 0;

  constructor() {
    this.rounds = new Map(SEED_ROUNDS.map(r => [r.id, { ...r }]));
  }

  private ensureSequence(): Promise<number> {
    if (!this.sequenceInit) {
      this.sequenceInit = (async () => {
        try {
          const ids = await prisma.betRecord.findMany({ select: { id: true } });
          let max = 0;
          for (const { id } of ids) {
            const match = /^bet-(\d+)$/.exec(id);
            if (match) max = Math.max(max, Number.parseInt(match[1], 10));
          }
          this.sequence = max;
        } catch (error) {
          logger.warn('Failed to resume bet sequence from BetRecord; starting from zero', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return this.sequence;
      })();
    }
    return this.sequenceInit;
  }

  private async nextBetId(): Promise<string> {
    await this.ensureSequence();
    this.sequence += 1;
    return `bet-${this.sequence}`;
  }

  private async persist(input: {
    address: string;
    amount: number;
    side?: 'UP' | 'DOWN';
    predictedPrice?: number;
    mode: 'updown' | 'precision';
    roundId?: string;
    status: BetStatus;
    timestamp?: string;
    submittedAt?: string;
  }): Promise<StoredBet> {
    const id = await this.nextBetId();
    const timestamp = new Date(input.timestamp ?? new Date().toISOString());

    const row = await prisma.betRecord.create({
      data: {
        id,
        address: input.address,
        amount: toDecimal(input.amount),
        side: input.side ?? null,
        predictedPrice:
          input.predictedPrice !== undefined ? toDecimal(input.predictedPrice) : null,
        mode: input.mode,
        roundId: input.roundId ?? null,
        timestamp,
        status: input.status,
        submittedAt: input.submittedAt ? new Date(input.submittedAt) : null,
      },
    });

    return betRecordToStoredBet(row);
  }

  async addUpDownBet(
    roundId: string,
    address: string,
    amount: number,
    side: 'UP' | 'DOWN',
    status: BetStatus = 'STUB',
  ): Promise<StoredBet> {
    const round = this.rounds.get(roundId);

    if (round && round.mode === 'updown') {
      if (side === 'UP') round.poolUp += amount;
      else round.poolDown += amount;
      round.totalPool = round.poolUp + round.poolDown;
    }

    return this.persist({
      roundId: round && round.mode === 'updown' ? roundId : undefined,
      address,
      amount,
      side,
      mode: 'updown',
      status,
      submittedAt: status === 'SUBMITTED' ? new Date().toISOString() : undefined,
    });
  }

  async addPrecisionBet(
    roundId: string,
    address: string,
    amount: number,
    predictedPrice: number,
    status: BetStatus = 'STUB',
  ): Promise<StoredBet> {
    const round = this.rounds.get(roundId);

    if (round && round.mode === 'precision') {
      round.totalPool += amount;
      round.predictionCount++;
    }

    return this.persist({
      roundId: round && round.mode === 'precision' ? roundId : undefined,
      address,
      amount,
      predictedPrice,
      mode: 'precision',
      status,
      submittedAt: status === 'SUBMITTED' ? new Date().toISOString() : undefined,
    });
  }

  /** Mark a bet as handed to Soroban, before the outcome is known. */
  async markSubmitted(betId: string): Promise<StoredBet | undefined> {
    const existing = await prisma.betRecord.findUnique({ where: { id: betId } });
    if (!existing) return undefined;

    const row = await prisma.betRecord.update({
      where: { id: betId },
      data: {
        status: 'SUBMITTED',
        submittedAt: existing.submittedAt ?? new Date(),
      },
    });
    return betRecordToStoredBet(row);
  }

  /**
   * Attach the on-chain transaction hash and mark the bet CONFIRMED.
   *
   * This is the stub → live upgrade path: a bet recorded as STUB while
   * BET_STUB_MODE was on can be reconciled here once its transaction is
   * known, without losing the original record or its timestamp.
   */
  async markConfirmed(betId: string, txHash: string): Promise<StoredBet | undefined> {
    const existing = await prisma.betRecord.findUnique({ where: { id: betId } });
    if (!existing) return undefined;

    const row = await prisma.betRecord.update({
      where: { id: betId },
      data: {
        status: 'CONFIRMED',
        txHash,
        submittedAt: existing.submittedAt ?? new Date(),
        confirmedAt: new Date(),
        failedAt: null,
        failureReason: null,
      },
    });
    return betRecordToStoredBet(row);
  }

  /** Mark an on-chain submission as rejected. */
  async markFailed(betId: string, failureReason: string): Promise<StoredBet | undefined> {
    const existing = await prisma.betRecord.findUnique({ where: { id: betId } });
    if (!existing) return undefined;

    const row = await prisma.betRecord.update({
      where: { id: betId },
      data: {
        status: 'FAILED',
        failedAt: new Date(),
        failureReason,
      },
    });
    return betRecordToStoredBet(row);
  }

  async getBet(betId: string): Promise<StoredBet | undefined> {
    const row = await prisma.betRecord.findUnique({ where: { id: betId } });
    return row ? betRecordToStoredBet(row) : undefined;
  }

  /** All bets, newest first, optionally narrowed by address/round/status. */
  async getBets(query: BetQuery = {}): Promise<StoredBet[]> {
    const where: {
      address?: string;
      roundId?: string;
      status?: string;
    } = {};
    if (query.address) where.address = query.address;
    if (query.roundId) where.roundId = query.roundId;
    if (query.status) where.status = query.status;

    const rows = await prisma.betRecord.findMany({
      where,
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
    });
    return rows.map(betRecordToStoredBet);
  }

  /** Count of bets per reconciliation status, for admin/audit summaries. */
  async getReconciliationSummary(): Promise<Record<BetStatus, number>> {
    const summary: Record<BetStatus, number> = {
      STUB: 0,
      SUBMITTED: 0,
      CONFIRMED: 0,
      FAILED: 0,
    };
    const groups = await prisma.betRecord.groupBy({
      by: ['status'],
      _count: { status: true },
    });
    for (const group of groups) {
      if (group.status in summary) {
        summary[group.status as BetStatus] = group._count.status;
      }
    }
    return summary;
  }

  async getRounds(): Promise<StoredRound[]> {
    return Array.from(this.rounds.values());
  }

  /**
   * Total bet count comes from the database so a process that restarted sees
   * every row its predecessors persisted — an in-memory counter would reset
   * to zero on boot and lie about the audit trail (Issue #519).
   */
  async getTotalBetsCount(): Promise<number> {
    return prisma.betRecord.count();
  }

  async getActiveRound(mode: 'updown' | 'precision'): Promise<StoredRound | undefined> {
    return Array.from(this.rounds.values()).find(
      r => r.mode === mode && r.status === 'live'
    );
  }

  /** Restore seed state. Test-isolation helper. */
  async reset(): Promise<void> {
    await prisma.betRecord.deleteMany({});
    this.rounds = new Map(SEED_ROUNDS.map(r => [r.id, { ...r }]));
    this.sequenceInit = null;
    this.sequence = 0;
  }
}

function betRecordToStoredBet(row: {
  id: string;
  address: string;
  amount: { toNumber(): number } | number;
  side: string | null;
  predictedPrice: { toNumber(): number } | number | null;
  mode: string;
  roundId: string | null;
  timestamp: Date | string;
  status: string;
  txHash: string | null;
  submittedAt: Date | null;
  confirmedAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
}): StoredBet {
  return {
    id: row.id,
    address: row.address,
    amount: toNumber(row.amount as number),
    side: row.side === 'UP' || row.side === 'DOWN' ? row.side : undefined,
    predictedPrice:
      row.predictedPrice !== null && row.predictedPrice !== undefined
        ? toNumber(row.predictedPrice as number)
        : undefined,
    mode: row.mode === 'precision' ? 'precision' : 'updown',
    roundId: row.roundId ?? undefined,
    timestamp:
      typeof row.timestamp === 'string' ? row.timestamp : row.timestamp.toISOString(),
    status: (['STUB', 'SUBMITTED', 'CONFIRMED', 'FAILED'] as const).includes(
      row.status as BetStatus,
    )
      ? (row.status as BetStatus)
      : 'STUB',
    txHash: row.txHash ?? undefined,
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : undefined,
    confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : undefined,
    failedAt: row.failedAt ? row.failedAt.toISOString() : undefined,
    failureReason: row.failureReason ?? undefined,
  };
}

/**
 * Decide which backend the bet store should use.
 *
 * An explicit `DATA_STORE` env var wins; otherwise `config.app.dataStore`
 * applies its auto-derivation (`DATA_MODE=mock` → `memory`, live → `postgres`).
 * Reading the env var per call (like `BET_STUB_MODE` in bet.service.ts) lets
 * tests flip the backend between cases without re-importing modules.
 */
export function resolveBetStoreKind(): BetStoreKind {
  const explicit = process.env.DATA_STORE;
  if (explicit === 'memory' || explicit === 'postgres') return explicit;
  return config.app.dataStore;
}

/**
 * Facade over the active bet-store backend.
 *
 * The backend is resolved lazily per call (see {@link resolveBetStoreKind}),
 * so a process that starts in mock mode and later gets `DATA_STORE=postgres`
 * can still persist — and, more importantly, unit tests can force the memory
 * backend while integration tests exercise the Prisma one.
 */
class BetStore {
  private memoryStore: InMemoryBetStore | null = null;
  private prismaStore: PrismaBetStore | null = null;

  private backend(): BetStoreBackend {
    if (resolveBetStoreKind() === 'postgres') {
      this.prismaStore ??= new PrismaBetStore();
      return this.prismaStore;
    }
    this.memoryStore ??= new InMemoryBetStore();
    return this.memoryStore;
  }

  addUpDownBet(
    roundId: string,
    address: string,
    amount: number,
    side: 'UP' | 'DOWN',
    status?: BetStatus,
  ): Promise<StoredBet> {
    return this.backend().addUpDownBet(roundId, address, amount, side, status);
  }

  addPrecisionBet(
    roundId: string,
    address: string,
    amount: number,
    predictedPrice: number,
    status?: BetStatus,
  ): Promise<StoredBet> {
    return this.backend().addPrecisionBet(
      roundId,
      address,
      amount,
      predictedPrice,
      status,
    );
  }

  markSubmitted(betId: string): Promise<StoredBet | undefined> {
    return this.backend().markSubmitted(betId);
  }

  markConfirmed(betId: string, txHash: string): Promise<StoredBet | undefined> {
    return this.backend().markConfirmed(betId, txHash);
  }

  markFailed(betId: string, failureReason: string): Promise<StoredBet | undefined> {
    return this.backend().markFailed(betId, failureReason);
  }

  getBet(betId: string): Promise<StoredBet | undefined> {
    return this.backend().getBet(betId);
  }

  getBets(query?: BetQuery): Promise<StoredBet[]> {
    return this.backend().getBets(query);
  }

  getReconciliationSummary(): Promise<Record<BetStatus, number>> {
    return this.backend().getReconciliationSummary();
  }

  getTotalBetsCount(): Promise<number> {
    return this.backend().getTotalBetsCount();
  }

  getRounds(): Promise<StoredRound[]> {
    return this.backend().getRounds();
  }

  getActiveRound(mode: 'updown' | 'precision'): Promise<StoredRound | undefined> {
    return this.backend().getActiveRound(mode);
  }

  reset(): Promise<void> {
    return this.backend().reset();
  }
}

export const betStore = new BetStore();

export { InMemoryBetStore, PrismaBetStore };
