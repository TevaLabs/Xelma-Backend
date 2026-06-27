import { describe, it, expect } from '@jest/globals';
import request from 'supertest';

// Mock Stellar and Soroban services to prevent loading @stellar/stellar-sdk (which contains ESM files that Jest fails to parse)
jest.mock('../services/stellar.service', () => ({
  isValidStellarAddress: (address: string) => address && address.startsWith('G') && address.length === 56,
  verifySignature: jest.fn(),
}));

jest.mock('../services/soroban.service', () => ({
  getUserStats: jest.fn(),
  getPendingWinnings: jest.fn(),
  getHealth: jest.fn(),
}));

import { createApp } from '../app';
import { errorHandler } from '../middleware/errorHandler';
import { notFoundHandler } from '../middleware/notFound';

describe('hackathon app error handling', () => {
  it('returns 404 JSON for unknown routes', async () => {
    const app = createApp();
    const res = await request(app).get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: 'Not Found',
      path: '/api/does-not-exist',
    });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('returns structured JSON for handler exceptions', async () => {
    const app = createApp({ includeErrorHandlers: false });
    app.get('/api/force-error', () => {
      throw new Error('forced failure');
    });
    app.use(notFoundHandler);
    app.use(errorHandler);

    const res = await request(app).get('/api/force-error');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Error');
    expect(res.body.message).toBe('forced failure');
  });
});
