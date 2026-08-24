import { decAdd, toNumber } from '../utils/decimal.util';

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

class BetStore {
  private rounds: Map<string, StoredRound>;
  private bets: Map<string, StoredBet> = new Map();
  private totalBetsCount = 0;
  private betSequence = 0;

  constructor() {
    this.rounds = new Map(SEED_ROUNDS.map(r => [r.id, { ...r }]));
  }

  private recordBet(partial: Omit<StoredBet, 'id' | 'timestamp'>): StoredBet {
    this.betSequence++;
    const id = `bet-${this.betSequence}`;
    const bet: StoredBet = {
      ...partial,
      id,
      timestamp: new Date().toISOString(),
    };
    this.bets.set(id, bet);
    this.totalBetsCount++;
    return bet;
  }

  addUpDownBet(
    roundId: string,
    address: string,
    amount: number,
    side: 'UP' | 'DOWN',
    status: BetStatus = 'STUB',
  ): StoredBet {
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

  addPrecisionBet(
    roundId: string,
    address: string,
    amount: number,
    predictedPrice: number,
    status: BetStatus = 'STUB',
  ): StoredBet {
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
  markSubmitted(betId: string): StoredBet | undefined {
    const bet = this.bets.get(betId);
    if (!bet) return undefined;

    bet.status = 'SUBMITTED';
    bet.submittedAt = bet.submittedAt ?? new Date().toISOString();
    return bet;
  }

  /**
   * Attach the on-chain transaction hash and mark the bet CONFIRMED.
   *
   * This is the stub → live upgrade path: a bet recorded as STUB while
   * BET_STUB_MODE was on can be reconciled here once its transaction is
   * known, without losing the original record or its timestamp.
   */
  markConfirmed(betId: string, txHash: string): StoredBet | undefined {
    const bet = this.bets.get(betId);
    if (!bet) return undefined;

    bet.status = 'CONFIRMED';
    bet.txHash = txHash;
    bet.submittedAt = bet.submittedAt ?? new Date().toISOString();
    bet.confirmedAt = new Date().toISOString();
    bet.failedAt = undefined;
    bet.failureReason = undefined;
    return bet;
  }

  /** Mark an on-chain submission as rejected. */
  markFailed(betId: string, failureReason: string): StoredBet | undefined {
    const bet = this.bets.get(betId);
    if (!bet) return undefined;

    bet.status = 'FAILED';
    bet.failedAt = new Date().toISOString();
    bet.failureReason = failureReason;
    return bet;
  }

  getBet(betId: string): StoredBet | undefined {
    const bet = this.bets.get(betId);
    return bet ? { ...bet } : undefined;
  }

  /** All bets, newest first, optionally narrowed by address/round/status. */
  getBets(query: BetQuery = {}): StoredBet[] {
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
  getReconciliationSummary(): Record<BetStatus, number> {
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

  getRounds(): StoredRound[] {
    return Array.from(this.rounds.values());
  }

  getTotalBetsCount(): number {
    return this.totalBetsCount;
  }

  getActiveRound(mode: 'updown' | 'precision'): StoredRound | undefined {
    return Array.from(this.rounds.values()).find(
      r => r.mode === mode && r.status === 'live'
    );
  }

  /** Restore seed state. Test-isolation helper. */
  reset(): void {
    this.rounds = new Map(SEED_ROUNDS.map(r => [r.id, { ...r }]));
    this.bets = new Map();
    this.totalBetsCount = 0;
    this.betSequence = 0;
  }
}

export const betStore = new BetStore();
