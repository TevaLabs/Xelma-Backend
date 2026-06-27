import test from 'node:test';
import assert from 'node:assert';
import { getMockRounds, mockLeaderboard } from '../data/mockData';
import { getPrices, getPriceSnapshot, resetPriceCache } from '../services/priceService';

const COINGECKO_SAMPLE = {
  bitcoin: { usd: 67420 },
  ethereum: { usd: 3241 },
  stellar: { usd: 0.2891 },
};

test('getPrices maps CoinGecko response to BTC, ETH, and XLM keys', async () => {
  resetPriceCache();
  const originalFetch = global.fetch;
  let fetchCalls = 0;

  global.fetch = (async () => {
    fetchCalls += 1;
    return {
      ok: true,
      json: async () => COINGECKO_SAMPLE,
    } as Response;
  }) as typeof fetch;

  try {
    const prices = await getPrices();
    assert.deepStrictEqual(prices, { BTC: 67420, ETH: 3241, XLM: 0.2891 });
    assert.strictEqual(fetchCalls, 1);
  } finally {
    global.fetch = originalFetch;
    resetPriceCache();
  }
});

test('getPrices serves cached values within 30 seconds', async () => {
  resetPriceCache();
  const originalFetch = global.fetch;
  let fetchCalls = 0;

  global.fetch = (async () => {
    fetchCalls += 1;
    return {
      ok: true,
      json: async () => COINGECKO_SAMPLE,
    } as Response;
  }) as typeof fetch;

  try {
    await getPrices();
    const cached = await getPrices();
    assert.deepStrictEqual(cached, { BTC: 67420, ETH: 3241, XLM: 0.2891 });
    assert.strictEqual(fetchCalls, 1, 'second request within 30s should use cache');
  } finally {
    global.fetch = originalFetch;
    resetPriceCache();
  }
});

test('getPrices returns graceful failure when upstream is down and cache is empty', async () => {
  resetPriceCache();
  const originalFetch = global.fetch;

  global.fetch = (async () => {
    throw new Error('network error');
  }) as typeof fetch;

  try {
    await assert.rejects(() => getPrices(), /network error/);
  } finally {
    global.fetch = originalFetch;
    resetPriceCache();
  }
});

test('getPriceSnapshot exposes stale metadata for operators', async () => {
  resetPriceCache();
  process.env.ORACLE_STALENESS_THRESHOLD_MS = '60000';
  const originalFetch = global.fetch;

  global.fetch = (async () => ({
    ok: true,
    json: async () => COINGECKO_SAMPLE,
  })) as unknown as typeof fetch;

  try {
    const snapshot = await getPriceSnapshot();
    assert.strictEqual(snapshot.stale, false);
    assert.strictEqual(typeof snapshot.lastUpdatedAt, 'string');
    assert.strictEqual(snapshot.source, 'coingecko');
  } finally {
    global.fetch = originalFetch;
    resetPriceCache();
  }
});

test('getMockRounds returns exactly 3 rounds with correct assets and dynamical future timestamps', () => {
  const rounds = getMockRounds();
  
  // Verify length
  assert.strictEqual(rounds.length, 3);
  
  // Verify assets and modes
  assert.strictEqual(rounds[0].id, 'btc-updown-live');
  assert.strictEqual(rounds[0].asset, 'BTC');
  assert.strictEqual(rounds[0].mode, 'updown');
  assert.strictEqual(rounds[0].status, 'live');
  assert.strictEqual(rounds[0].startPrice, 67420);
  
  assert.strictEqual(rounds[1].id, 'eth-precision-live');
  assert.strictEqual(rounds[1].asset, 'ETH');
  assert.strictEqual(rounds[1].mode, 'precision');
  assert.strictEqual(rounds[1].status, 'live');
  assert.strictEqual(rounds[1].startPrice, 3241);
  
  assert.strictEqual(rounds[2].id, 'xlm-updown-new');
  assert.strictEqual(rounds[2].asset, 'XLM');
  assert.strictEqual(rounds[2].mode, 'updown');
  assert.strictEqual(rounds[2].status, 'new');
  assert.strictEqual(rounds[2].startPrice, 0.2891);

  // Verify dynamic future timestamps
  const now = Date.now();
  rounds.forEach((round) => {
    const closesAtTime = new Date(round.closesAt).getTime();
    assert.ok(closesAtTime > now, `closesAt (${round.closesAt}) should be in the future relative to ${new Date(now).toISOString()}`);
  });
});

test('mockLeaderboard contains exactly 10 users sorted by rank with valid Stellar-like addresses', () => {
  assert.strictEqual(mockLeaderboard.length, 10);
  
  let previousRank = 0;
  mockLeaderboard.forEach((user) => {
    // Ranks should be 1, 2, 3, etc. and increasing
    assert.ok(user.rank > previousRank, `user rank (${user.rank}) should be higher than previous (${previousRank})`);
    previousRank = user.rank;
    
    // Address check: must start with 'G' and have standard length, or at least be a string starting with G
    assert.strictEqual(typeof user.address, 'string');
    assert.ok(user.address.startsWith('G'), `address (${user.address}) must start with G`);
    
    // Required fields check
    assert.strictEqual(typeof user.totalWins, 'number');
    assert.strictEqual(typeof user.totalLosses, 'number');
    assert.strictEqual(typeof user.winStreak, 'number');
    assert.strictEqual(typeof user.xp, 'number');
    assert.strictEqual(typeof user.rankTitle, 'string');
  });
});
