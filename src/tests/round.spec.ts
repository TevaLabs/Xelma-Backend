import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { prisma } from '../lib/prisma';
import request from 'supertest';
import app from '../index';
import { generateToken } from '../utils/jwt.util';

const hasDb = Boolean(process.env.DATABASE_URL);
const isCI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
const runRoundE2E = process.env.RUN_ROUND_E2E === 'true';
const describeRound = hasDb && !isCI && runRoundE2E ? describe : describe.skip;

describeRound('Round Prediction Flow - LEGENDS Integration', () => {
  let adminUser: any;
  let userA: any;
  let userB: any;
  let adminToken: string;
  let userAToken: string;
  let userBToken: string;

  beforeAll(async () => {
    adminUser = await prisma.user.create({
      data: {
        walletAddress: 'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        publicKey: 'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        role: 'ADMIN',
      },
    });

    userA = await prisma.user.create({
      data: {
        walletAddress: 'GUSERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1',
        publicKey: 'GUSERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1',
      },
    });

    userB = await prisma.user.create({
      data: {
        walletAddress: 'GUSERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2',
        publicKey: 'GUSERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2',
      },
    });

    adminToken = generateToken(adminUser.id, adminUser.walletAddress);
    userAToken = generateToken(userA.id, userA.walletAddress);
    userBToken = generateToken(userB.id, userB.walletAddress);
  });

  afterAll(async () => {
    await prisma.prediction.deleteMany({});
    await prisma.round.deleteMany({});
    await prisma.user.deleteMany({});
  });

  beforeEach(async () => {
    await prisma.prediction.deleteMany({});
    await prisma.round.deleteMany({});
  });

  it('supports LEGENDS start -> predict -> resolve flow with range payouts', async () => {
    const priceRanges = [
      { min: 1.1, max: 1.2 },
      { min: 1.2, max: 1.3 },
      { min: 1.3, max: 1.4 },
    ];

    const startRes = await request(app)
      .post('/api/rounds/start')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        mode: 1,
        startPrice: 1.23,
        duration: 5,
        priceRanges,
      })
      .expect(200);

    expect(startRes.body.success).toBe(true);
    expect(startRes.body.round.mode).toBe('LEGENDS');
    expect(startRes.body.round.priceRanges).toHaveLength(3);
    const roundId = startRes.body.round.id;

    await request(app)
      .post('/api/predictions/submit')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({
        roundId,
        amount: 100,
        priceRange: { min: 1.2, max: 1.3 },
      })
      .expect(200)
      .expect((res) => {
        expect(res.body.success).toBe(true);
        expect(res.body.prediction.roundId).toBe(roundId);
        expect(res.body.prediction.priceRange).toEqual({ min: 1.2, max: 1.3 });
      });

    await request(app)
      .post('/api/predictions/submit')
      .set('Authorization', `Bearer ${userBToken}`)
      .send({
        roundId,
        amount: 200,
        priceRange: { min: 1.3, max: 1.4 },
      })
      .expect(200);

    const resolveRes = await request(app)
      .post(`/api/rounds/${roundId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ finalPrice: 1.25 })
      .expect(200);

    expect(resolveRes.body.success).toBe(true);
    expect(resolveRes.body.round.status).toBe('RESOLVED');
    expect(resolveRes.body.round.predictions).toBe(2);
    expect(resolveRes.body.round.winners).toBe(1);

    const predictionsRes = await request(app)
      .get(`/api/predictions/round/${roundId}`)
      .expect(200);

    const winners = predictionsRes.body.predictions.filter((p: any) => p.won === true);
    const losers = predictionsRes.body.predictions.filter((p: any) => p.won === false);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(Number(winners[0].payout)).toBeCloseTo(300, 8);
    expect(Number(losers[0].payout)).toBe(0);
  });

  it('rejects LEGENDS prediction when range does not belong to round', async () => {
    const startRes = await request(app)
      .post('/api/rounds/start')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        mode: 1,
        startPrice: 2.0,
        duration: 5,
        priceRanges: [
          { min: 1.8, max: 2.0 },
          { min: 2.0, max: 2.2 },
        ],
      })
      .expect(200);

    await request(app)
      .post('/api/predictions/submit')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({
        roundId: startRes.body.round.id,
        amount: 50,
        priceRange: { min: 2.2, max: 2.4 },
      })
      .expect(400)
      .expect((res) => {
        expect(res.body.message).toContain('Invalid price range');
      });
  });
});
