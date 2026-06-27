import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import axios from 'axios';
import { createApp } from '../app';
import { resetPriceCache } from '../services/priceService';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockCoinGecko = {
  bitcoin: { usd: 67_420.12 },
  ethereum: { usd: 3_241.55 },
  stellar: { usd: 0.2891 },
};

describe('GET /api/prices', () => {
  beforeEach(() => {
    resetPriceCache();
    mockedAxios.get.mockReset();
    jest.useRealTimers();
  });

  it('returns live prices from CoinGecko', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: mockCoinGecko });
    const app = createApp();

    const res = await request(app).get('/api/prices');

    expect(res.status).toBe(200);
    expect(res.body.BTC).toBe(67_420.12);
    expect(res.body.ETH).toBe(3_241.55);
    expect(res.body.XLM).toBe(0.2891);
    expect(res.body.stale).toBe(false);
    expect(res.body.lastUpdatedAt).toBeTruthy();
  });

  it('uses cache on subsequent requests within 30 seconds', async () => {
    jest.useFakeTimers();
    mockedAxios.get.mockResolvedValue({ data: mockCoinGecko });
    const app = createApp();

    await request(app).get('/api/prices');
    jest.advanceTimersByTime(15_000);
    await request(app).get('/api/prices');

    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when CoinGecko fails and no cache exists', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('network error'));
    const app = createApp();

    const res = await request(app).get('/api/prices');

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_SERVER_ERROR');
  });
});
