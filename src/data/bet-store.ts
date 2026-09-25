/**
 * Demo/hackathon bet audit trail.
 *
 * Historically this store kept every bet in a process-local `Map`, so a deploy,
 * a crash, or a second replica silently dropped the whole demo audit trail
 * (issue #624, previously #519/#577). The store now has two backends behind one
 * API:
 *
 *   - `memory`   — the original in-process `Map`/`Decimal` backend. Used for
 *                  `DATA_MODE=mock` / `DATA_STORE=memory` boots that have no
 *                  database at all.
 *   - `postgres` — persists every bet to the `BetRecord` table, so demo bets
 *                  survive a process restart and are visible to every replica.
 *
 * The backend is resolved from `BET_STORE` when set, otherwise it follows
 * `DATA_STORE` (which itself defaults to `memory` for `DATA_MODE=mock`). See
 * docs/runtime-modes.md.
 *
 * The backend is resolved per call rather than once at import time: tests (and
 * `DATA_STORE=memory` demo boots) flip the flag inside a running process, and
 * the memory backend has to keep behaving exactly as it did before.
 */
import config from '../config';
import { prisma } from '../lib/prisma';
import logger from '../utils/logger';
import { decAdd, toDecimal, toNumber } from '../utils/decimal.util';

export type BetStatus = 'STUB' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';

export type StoredBetMode = 'updown' | 'precision';

export interface StoredBet {
  id: string;
  address: string;
  amount: number;
  side?: 'UP' | 'DOWN';
  predictedPrice?: number;
  mode: StoredBetMode;
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

/**
 * Everything needed to record one bet. `id` is optional so a caller that
 * already owns the canonical record id (e.g. `BetService`, whose primary
 * ledger id comes from the `Bet` table) can keep both rows linked.
 */
export interface BetRecordInput {
  id?: string;
  address: string;
  amount: number | string;
  mode: StoredBetMode;
  side?: 'UP' | 'DOWN';
  predictedPrice?: number;
  roundId?: string;
  status?: BetStatus;
  txHash?: string;
  timestamp?: string;
}

export type BetStoreBackend = 'memory' | 'postgres';

/**
 * The store API every backend implements. All persistence-touching methods are
 * async so the Postgres backend can be awaited without a second API surface.
 */
export interface BetStore {
  recordBet(input: BetRecordInput): Promise<StoredBet>;
  addUpDownBet(
    roundId: string,
    address: string,
    amount: number | string,
    side: 'UP' | 'DOWN',
    status?: BetStatus,
  ): Promise<StoredBet>;
  addPrecisionBet(
    roundId: string,
    address: string,
    amount: number | string,
    predictedPrice: number,
    status?: BetStatus,
  ): Promise<StoredBet>;
  /** Mark a bet as handed to Soroban, before the outcome is known. */
  markSubmitted(betId: string): Promise<StoredBet | undefined>;
  /**
   * Attach the on-chain transaction hash and mark the bet CONFIRMED.
   *
   * This is the stub → live upgrade path: a bet recorded as STUB while
   * BET_STUB_MODE was on can be reconciled here once its transaction is
   * known, without losing the original record or its timestamp.
   */
  markConfirmed(betId: string, txHash: string): Promise<StoredBet | undefined>;
  /** Mark an on-chain submission as rejected. */
  markFailed(betId: string, failureReason: string): Promise<StoredBet | undefined>;
  getBet(betId: string): Promise<StoredBet | undefined>;
  /** All bets, newest first, optionally narrowed by address/round/status. */
  getBets(query?: BetQuery): Promise<StoredBet[]>;
  /** Count of bets per reconciliation status, for admin/audit summaries. */
  getReconciliationSummary(): Promise<Record<BetStatus, number>>;
  getRounds(): StoredRound[];
  getTotalBetsCount(): Promise<number>;
  getActiveRound(mode: 'updown' | 'precision'): StoredRound | undefined;
  /**
   * Restore seed state. Test-isolation helper only — on the Postgres backend
   * this deletes every `BetRecord` row, so never call it outside tests.
   */
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
 * Demo round fixtures and their running pool totals.
 *
 * Rounds (and their pool math) are deliberately *not* persisted — the durable
 * part of the store is the bet audit trail. Both backends share this registry
 * so `getRounds()`/`getActiveRound()` behave identically either way.
 */
export class RoundRegistry {
  private rounds: Map<string, StoredRound> = new Map();

  constructor() {
    this.reset();
  }

  reset(): void {
    this.rounds = new Map(SEED_ROUNDS.map((r) => [r.id, { ...r }]));
  }

  find(roundId: string): StoredRound | undefined {
    return this.rounds.get(roundId);
  }

  all(): StoredRound[] {
    return Array.from(this.rounds.values());
  }

  active(mode: 'updown' | 'precision'): StoredRound | undefined {
    return this.all().find((r) => r.mode === mode && r.status === 'live');
  }

  /** Accumulate an UP/DOWN stake onto the round's pool, when the round is known. */
  trackUpDown(roundId: string, amount: number, side: 'UP' | 'DOWN'): void {
    const round = this.rounds.get(roundId);
    if (!round || round.mode !== 'updown') return;

    if (side === 'UP') {
      round.poolUp = toNumber(decAdd(round.poolUp, amount));
    } else {
      round.poolDown = toNumber(decAdd(round.poolDown, amount));
    }
    round.totalPool = toNumber(decAdd(round.poolUp, round.poolDown));
  }

  /** Accumulate a precision stake onto the round's total pool. */
  trackPrecision(roundId: string, amount: number): void {
    const round = this.rounds.get(roundId);
    if (!round || round.mode !== 'precision') return;

    round.totalPool = toNumber(decAdd(round.totalPool, amount));
    round.predictionCount += 1;
  }
}

const roundRegistry = new RoundRegistry();

/**
 * Resolve the configured backend.
 *
 * Precedence: explicit `BET_STORE` → `DATA_STORE` → `DATA_MODE` (mock implies
 * memory) → the parsed `config.app.dataStore` default.
 */
export function resolveBetStoreBackend(
  env: NodeJS.ProcessEnv = process.env,
): BetStoreBackend {
  const explicit = (env.BET_STORE ?? '').trim().toLowerCase();
  if (explicit === 'memory') return 'memory';
  if (explicit === 'postgres' || explicit === 'prisma') return 'postgres';

  if (env.DATA_STORE === 'memory') return 'memory';
  if (!env.DATA_STORE && env.DATA_MODE === 'mock') return 'memory';

  return config.app.dataStore === 'memory' ? 'memory' : 'postgres';
}

/** In-process `Map` backend. Requires no database (`DATA_MODE=mock`). */
export class MemoryBetStore implements BetStore {
  private bets: Map<string, StoredBet> = new Map();
  private totalBetsCount = 0;
  private betSequence = 0;

  async recordBet(input: BetRecordInput): Promise<StoredBet> {
    const bet: StoredBet = {
      id: input.id ?? `bet-${++this.betSequence}`,
      address: input.address,
      amount: toNumber(toDecimal(input.amount)),
      side: input.side,
      predictedPrice: input.predictedPrice,
      mode: input.mode,
      roundId: input.roundId || undefined,
      timestamp: input.timestamp ?? new Date().toISOString(),
      status: input.status ?? 'STUB',
      txHash: input.txHash,
      submittedAt:
        input.status === 'SUBMITTED' || input.status === 'CONFIRMED'
          ? new Date().toISOString()
          : undefined,
    };

    this.bets.set(bet.id, bet);
    this.totalBetsCount += 1;
    return { ...bet };
  }

  async addUpDownBet(
    roundId: string,
    address: string,
    amount: number | string,
    side: 'UP' | 'DOWN',
    status: BetStatus = 'STUB',
  ): Promise<StoredBet> {
    const numAmount = toNumber(toDecimal(amount));
    roundRegistry.trackUpDown(roundId, numAmount, side);

    return this.recordBet({
      roundId,
      address,
      amount: numAmount,
      side,
      mode: 'updown',
      status,
    });
  }

  async addPrecisionBet(
    roundId: string,
    address: string,
    amount: number | string,
    predictedPrice: number,
    status: BetStatus = 'STUB',
  ): Promise<StoredBet> {
    const numAmount = toNumber(toDecimal(amount));
    roundRegistry.trackPrecision(roundId, numAmount);

    return this.recordBet({
      roundId,
      address,
      amount: numAmount,
      predictedPrice,
      mode: 'precision',
      status,
    });
  }

  async markSubmitted(betId: string): Promise<StoredBet | undefined> {
    const bet = this.bets.get(betId);
    if (!bet) return undefined;

    bet.status = 'SUBMITTED';
    bet.submittedAt = bet.submittedAt ?? new Date().toISOString();
    return { ...bet };
  }

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

  async getBets(query: BetQuery = {}): Promise<StoredBet[]> {
    return Array.from(this.bets.values())
      .filter((bet) => {
        if (query.address && bet.address !== query.address) return false;
        if (query.roundId && bet.roundId !== query.roundId) return false;
        if (query.status && bet.status !== query.status) return false;
        return true;
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id))
      .map((bet) => ({ ...bet }));
  }

  async getReconciliationSummary(): Promise<Record<BetStatus, number>> {
    const summary: Record<BetStatus, number> = {
      STUB: 0,
      SUBMITTED: 0,
      CONFIRMED: 0,
      FAILED: 0,
    };
    for (const bet of this.bets.values()) {
      summary[bet.status] += 1;
    }
    return summary;
  }

  getRounds(): StoredRound[] {
    return roundRegistry.all();
  }

  async getTotalBetsCount(): Promise<number> {
    return this.totalBetsCount;
  }

  getActiveRound(mode: 'updown' | 'precision'): StoredRound | undefined {
    return roundRegistry.active(mode);
  }

  async reset(): Promise<void> {
    this.bets = new Map();
    this.totalBetsCount = 0;
    this.betSequence = 0;
    roundRegistry.reset();
  }
}

/** Row shape returned by `prisma.betRecord`. */
interface BetRecordRow {
  id: string;
  address: string;
  amount: unknown;
  mode: string;
  side: string | null;
  predictedPrice: unknown;
  roundId: string | null;
  status: string;
  txHash: string | null;
  submittedAt: Date | null;
  confirmedAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
}

/**
 * Durable backend. Every bet is written to the `BetRecord` table, so a process
 * restart (or a second replica) can still read it back.
 */
export class PostgresBetStore implements BetStore {
  async recordBet(input: BetRecordInput): Promise<StoredBet> {
    const status = input.status ?? 'STUB';
    const submittedAt =
      status === 'SUBMITTED' || status === 'CONFIRMED' ? new Date() : null;

    const row = (await prisma.betRecord.create({
      data: {
        ...(input.id ? { id: input.id } : {}),
        address: input.address,
        amount: toDecimal(input.amount),
        mode: input.mode,
        side: input.side ?? null,
        predictedPrice:
          input.predictedPrice !== undefined ? toDecimal(input.predictedPrice) : null,
        roundId: input.roundId || null,
        status,
        txHash: input.txHash ?? null,
        submittedAt,
      },
    })) as unknown as BetRecordRow;

    return this.mapRow(row);
  }

  async addUpDownBet(
    roundId: string,
    address: string,
    amount: number | string,
    side: 'UP' | 'DOWN',
    status: BetStatus = 'STUB',
  ): Promise<StoredBet> {
    const numAmount = toNumber(toDecimal(amount));
    roundRegistry.trackUpDown(roundId, numAmount, side);

    return this.recordBet({
      roundId,
      address,
      amount: numAmount,
      side,
      mode: 'updown',
      status,
    });
  }

  async addPrecisionBet(
    roundId: string,
    address: string,
    amount: number | string,
    predictedPrice: number,
    status: BetStatus = 'STUB',
  ): Promise<StoredBet> {
    const numAmount = toNumber(toDecimal(amount));
    roundRegistry.trackPrecision(roundId, numAmount);

    return this.recordBet({
      roundId,
      address,
      amount: numAmount,
      predictedPrice,
      mode: 'precision',
      status,
    });
  }

  async markSubmitted(betId: string): Promise<StoredBet | undefined> {
    const existing = await this.getBet(betId);
    if (!existing) return undefined;

    return this.update(betId, {
      status: 'SUBMITTED',
      submittedAt: existing.submittedAt ? new Date(existing.submittedAt) : new Date(),
    });
  }

  async markConfirmed(betId: string, txHash: string): Promise<StoredBet | undefined> {
    const existing = await this.getBet(betId);
    if (!existing) return undefined;

    return this.update(betId, {
      status: 'CONFIRMED',
      txHash,
      submittedAt: existing.submittedAt ? new Date(existing.submittedAt) : new Date(),
      confirmedAt: new Date(),
      failedAt: null,
      failureReason: null,
    });
  }

  async markFailed(betId: string, failureReason: string): Promise<StoredBet | undefined> {
    const existing = await this.getBet(betId);
    if (!existing) return undefined;

    return this.update(betId, {
      status: 'FAILED',
      failedAt: new Date(),
      failureReason,
    });
  }

  async getBet(betId: string): Promise<StoredBet | undefined> {
    const row = (await prisma.betRecord.findUnique({
      where: { id: betId },
    })) as unknown as BetRecordRow | null;

    return row ? this.mapRow(row) : undefined;
  }

  async getBets(query: BetQuery = {}): Promise<StoredBet[]> {
    const rows = (await prisma.betRecord.findMany({
      where: {
        address: query.address,
        roundId: query.roundId,
        status: query.status,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })) as unknown as BetRecordRow[];

    return rows.map((row) => this.mapRow(row));
  }

  async getReconciliationSummary(): Promise<Record<BetStatus, number>> {
    const summary: Record<BetStatus, number> = {
      STUB: 0,
      SUBMITTED: 0,
      CONFIRMED: 0,
      FAILED: 0,
    };

    const counts = (await prisma.betRecord.groupBy({
      by: ['status'],
      _count: { status: true },
    })) as unknown as Array<{ status: string; _count: { status: number } }>;

    for (const count of counts) {
      if (count.status in summary) {
        summary[count.status as BetStatus] = count._count.status;
      }
    }
    return summary;
  }

  getRounds(): StoredRound[] {
    return roundRegistry.all();
  }

  async getTotalBetsCount(): Promise<number> {
    return prisma.betRecord.count();
  }

  getActiveRound(mode: 'updown' | 'precision'): StoredRound | undefined {
    return roundRegistry.active(mode);
  }

  async reset(): Promise<void> {
    await prisma.betRecord.deleteMany();
    roundRegistry.reset();
  }

  private async update(
    betId: string,
    data: Record<string, unknown>,
  ): Promise<StoredBet | undefined> {
    const row = (await prisma.betRecord.update({
      where: { id: betId },
      data,
    })) as unknown as BetRecordRow;

    return row ? this.mapRow(row) : undefined;
  }

  private mapRow(row: BetRecordRow): StoredBet {
    return {
      id: row.id,
      address: row.address,
      amount: toNumber(row.amount as never),
      side: (row.side as 'UP' | 'DOWN' | null) ?? undefined,
      predictedPrice:
        row.predictedPrice === null || row.predictedPrice === undefined
          ? undefined
          : toNumber(row.predictedPrice as never),
      mode: row.mode as StoredBetMode,
      roundId: row.roundId ?? undefined,
      timestamp: new Date(row.createdAt).toISOString(),
      status: row.status as BetStatus,
      txHash: row.txHash ?? undefined,
      submittedAt: row.submittedAt ? new Date(row.submittedAt).toISOString() : undefined,
      confirmedAt: row.confirmedAt ? new Date(row.confirmedAt).toISOString() : undefined,
      failedAt: row.failedAt ? new Date(row.failedAt).toISOString() : undefined,
      failureReason: row.failureReason ?? undefined,
    };
  }
}

/**
 * Build a store instance for an explicit backend. Production code should use
 * the {@link betStore} facade; this exists for tests that need to model a
 * process restart (a fresh instance bound to the same database).
 */
export function createBetStore(backend: BetStoreBackend = resolveBetStoreBackend()): BetStore {
  return backend === 'memory' ? new MemoryBetStore() : new PostgresBetStore();
}

/**
 * Facade that routes every call to the currently configured backend, caching
 * one instance per backend so the memory backend keeps its state across calls.
 */
function createBetStoreFacade(): BetStore {
  const instances: Record<BetStoreBackend, BetStore | null> = {
    memory: null,
    postgres: null,
  };

  const current = (): BetStore => {
    const backend = resolveBetStoreBackend();
    if (!instances[backend]) {
      instances[backend] = createBetStore(backend);
      logger.info('Bet store backend selected', { backend });
    }
    return instances[backend] as BetStore;
  };

  return {
    recordBet: (input) => current().recordBet(input),
    addUpDownBet: (roundId, address, amount, side, status) =>
      current().addUpDownBet(roundId, address, amount, side, status),
    addPrecisionBet: (roundId, address, amount, predictedPrice, status) =>
      current().addPrecisionBet(roundId, address, amount, predictedPrice, status),
    markSubmitted: (betId) => current().markSubmitted(betId),
    markConfirmed: (betId, txHash) => current().markConfirmed(betId, txHash),
    markFailed: (betId, failureReason) => current().markFailed(betId, failureReason),
    getBet: (betId) => current().getBet(betId),
    getBets: (query) => current().getBets(query),
    getReconciliationSummary: () => current().getReconciliationSummary(),
    // Round fixtures are process-local and backend-independent.
    getRounds: () => roundRegistry.all(),
    getTotalBetsCount: () => current().getTotalBetsCount(),
    getActiveRound: (mode) => roundRegistry.active(mode),
    // Only reset backends that were actually used: instantiating the Postgres
    // backend just to clear it would hit the database during backend-less tests.
    reset: async () => {
      for (const backend of Object.keys(instances) as BetStoreBackend[]) {
        if (instances[backend]) {
          await instances[backend]!.reset();
        }
      }
      roundRegistry.reset();
    },
  };
}

export const betStore: BetStore = createBetStoreFacade();
