export interface StoredBet {
  address: string;
  amount: number;
  side?: 'UP' | 'DOWN';
  predictedPrice?: number;
  roundId: string;
  timestamp: string;
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
  private bets: StoredBet[] = [];
  private totalBetsCount = 0;

  constructor() {
    this.rounds = new Map(SEED_ROUNDS.map(r => [r.id, { ...r }]));
  }

  addUpDownBet(roundId: string, address: string, amount: number, side: 'UP' | 'DOWN'): void {
    const round = this.rounds.get(roundId);
    if (!round || round.mode !== 'updown') return;

    if (side === 'UP') round.poolUp += amount;
    else round.poolDown += amount;
    round.totalPool = round.poolUp + round.poolDown;

    this.bets.push({ roundId, address, amount, side, timestamp: new Date().toISOString() });
    this.totalBetsCount++;
  }

  addPrecisionBet(roundId: string, address: string, amount: number, predictedPrice: number): void {
    const round = this.rounds.get(roundId);
    if (!round || round.mode !== 'precision') return;

    round.totalPool += amount;
    round.predictionCount++;

    this.bets.push({ roundId, address, amount, predictedPrice, timestamp: new Date().toISOString() });
    this.totalBetsCount++;
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
}

export const betStore = new BetStore();
