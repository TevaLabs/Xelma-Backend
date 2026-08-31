import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import axios from 'axios';

jest.mock('../services/stellar.service', () => ({
  isValidStellarAddress: (address: string) =>
    address && address.startsWith('G') && address.length === 56,
  verifySignature: jest.fn(),
}));

jest.mock('../services/soroban.service', () => ({
  isReady: jest.fn().mockReturnValue(true),
  getUserStats: jest.fn(),
  getPendingWinnings: jest.fn(),
  getHealth: jest.fn(),
}));

import { createApp as createMainApp } from '../index';
import { createApp as createHackathonApp } from '../app';
import { resetPriceCache } from '../services/priceService';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockCoinGecko = {
  bitcoin: { usd: 67_420.12 },
  ethereum: { usd: 3_241.55 },
  stellar: { usd: 0.2891 },
};

describe('GET /api/prices contract — both apps return identical envelope', () => {
  beforeEach(() => {
    resetPriceCache();
    mockedAxios.get.mockReset();
    jest.useRealTimers();
  });

  it('main app returns { success, data } envelope', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: mockCoinGecko });
    const app = createMainApp();

    const res = await request(app).get('/api/prices');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.BTC).toBe(67_420.12);
    expect(res.body.data.ETH).toBe(3_241.55);
    expect(res.body.data.XLM).toBe(0.2891);
    expect(res.body.data.stale).toBe(false);
    expect(typeof res.body.data.lastUpdatedAt).toBe('string');
  });

  it('hackathon app returns { success, data } envelope', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: mockCoinGecko });
    const app = createHackathonApp();

    const res = await request(app).get('/api/prices');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.BTC).toBe(67_420.12);
    expect(res.body.data.ETH).toBe(3_241.55);
    expect(res.body.data.XLM).toBe(0.2891);
    expect(res.body.data.stale).toBe(false);
    expect(typeof res.body.data.lastUpdatedAt).toBe('string');
  });

  it('both apps return identical top-level keys', async () => {
    mockedAxios.get.mockResolvedValue({ data: mockCoinGecko });
    const mainApp = createMainApp();
    const hackathonApp = createHackathonApp();

    const mainRes = await request(mainApp).get('/api/prices');
    const hackRes = await request(hackathonApp).get('/api/prices');

    const mainKeys = Object.keys(mainRes.body).sort();
    const hackKeys = Object.keys(hackRes.body).sort();
    expect(mainKeys).toEqual(hackKeys);

    const mainDataKeys = Object.keys(mainRes.body.data).sort();
    const hackDataKeys = Object.keys(hackRes.body.data).sort();
    expect(mainDataKeys).toEqual(hackDataKeys);
  });
});
