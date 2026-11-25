import { describe, it, expect, beforeAll, beforeEach } from '@jest/globals';
import request from 'supertest';
import { Express } from 'express';
import { UserRole } from '@prisma/client';
import { createApp } from '../index';
import { generateToken } from '../utils/jwt.util';

const USER_ID = 'export-user-id';
const WALLET = 'GEXPORT_USER_TEST_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const mockUserFindUnique = jest.fn();
const mockPredictionFindMany = jest.fn();

jest.mock('../lib/prisma', () => ({
  prisma: {
    user: { findUnique: (...args: any[]) => mockUserFindUnique(...args) },
    prediction: { findMany: (...args: any[]) => mockPredictionFindMany(...args) },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

const HEADER =
  'id,round_id,round_mode,round_status,side,amount,price_range_min,price_range_max,won,payout,round_start_price,round_end_price,created_at';

function prediction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    userId: USER_ID,
    roundId: 'r-1',
    side: 'UP',
    amount: '10.12345678',
    priceRange: null,
    won: true,
    payout: '15.5',
    createdAt: new Date('2026-03-04T05:06:07.000Z'),
    round: {
      id: 'r-1',
      mode: 'UP_DOWN',
      status: 'RESOLVED',
      startPrice: '0.1',
      endPrice: '0.125',
    },
    ...overrides,
  };
}

/** Collects the raw response body as text, however the server chunked it. */
function csvOf(res: request.Response): string {
  return typeof res.text === 'string' ? res.text : res.body.toString('utf8');
}

describe('GET /api/predictions/user/export', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    app = createApp();
    token = generateToken(USER_ID, WALLET, UserRole.USER);
  });

  beforeEach(() => {
    mockUserFindUnique.mockResolvedValue({
      id: USER_ID,
      walletAddress: WALLET,
      role: UserRole.USER,
    });
    mockPredictionFindMany.mockResolvedValue([]);
  });

  const get = () =>
    request(app)
      .get('/api/predictions/user/export')
      .buffer(true)
      .parse((res, cb) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => cb(null, data));
      })
      .set('Authorization', `Bearer ${token}`);

  it('requires authentication', async () => {
    const res = await request(app).get('/api/predictions/user/export');
    expect(res.status).toBe(401);
    expect(mockPredictionFindMany).not.toHaveBeenCalled();
  });

  it('streams a CSV attachment with just the header for a user with no predictions', async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="xelma-predictions-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(csvOf(res as any)).toBe(`${HEADER}\r\n`);
  });

  it('writes one row per prediction with 8-decimal money and empty cells for nulls', async () => {
    mockPredictionFindMany.mockResolvedValueOnce([
      prediction(),
      prediction({
        id: 'p-2',
        roundId: 'r-2',
        side: null,
        amount: 5,
        priceRange: { min: 0.11, max: 0.12 },
        won: null,
        payout: null,
        round: { id: 'r-2', mode: 'LEGENDS', status: 'ACTIVE', startPrice: '0.1', endPrice: null },
      }),
    ]);

    const res = await get();

    expect(csvOf(res as any).split('\r\n')).toEqual([
      HEADER,
      'p-1,r-1,UP_DOWN,RESOLVED,UP,10.12345678,,,true,15.50000000,0.10000000,0.12500000,2026-03-04T05:06:07.000Z',
      'p-2,r-2,LEGENDS,ACTIVE,,5.00000000,0.11,0.12,,,0.10000000,,2026-03-04T05:06:07.000Z',
      '',
    ]);
  });

  it("only reads the authenticated user's predictions, newest first", async () => {
    await get();

    expect(mockPredictionFindMany).toHaveBeenCalledTimes(1);
    const args = mockPredictionFindMany.mock.calls[0][0] as any;
    expect(args.where).toEqual({ userId: USER_ID });
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('pages through large histories with a keyset cursor instead of loading them at once', async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => prediction({ id: `a-${i}` }));
    const page2 = Array.from({ length: 2 }, (_, i) => prediction({ id: `b-${i}` }));
    mockPredictionFindMany.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

    const res = await get();

    const lines = csvOf(res as any).split('\r\n');
    expect(lines).toHaveLength(1 + 502 + 1);
    expect(lines[1].startsWith('a-0,')).toBe(true);
    expect(lines[501].startsWith('b-0,')).toBe(true);
    expect(mockPredictionFindMany).toHaveBeenCalledTimes(2);
    const second = mockPredictionFindMany.mock.calls[1][0] as any;
    expect(second.cursor).toEqual({ id: 'a-499' });
    expect(second.skip).toBe(1);
    expect(second.take).toBe(500);
  });

  it('cuts the connection instead of returning a truncated file when the database fails mid-stream', async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => prediction({ id: `a-${i}` }));
    mockPredictionFindMany
      .mockResolvedValueOnce(page1)
      .mockRejectedValueOnce(new Error('db down'));

    await expect(get()).rejects.toThrow();
  });
});
