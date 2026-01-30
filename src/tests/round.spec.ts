import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { prisma } from '../lib/prisma';
import request from 'supertest';
import app from '../index';
import { GameMode, BetSide } from '../types/round.types';
import { generateToken } from '../utils/jwt.util';
import * as StellarSdk from '@stellar/stellar-sdk';

describe('Round Prediction Flow - End-to-End Test', () => {
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

  describe('Full Round Lifecycle (Up/Down Mode)', () => {
    it('should complete a full Up/Down round: start -> predict -> resolve', async () => {
      const startPrice = '1.23';
      const durationLedgers = 60;
      const finalPrice = '1.45';

      let roundId: string | undefined;
      let predictionAId: string | undefined;
      let predictionBId: string | undefined;
      let resolveTxHash: string | undefined;

      await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          startPrice,
          durationLedgers,
          mode: GameMode.UP_DOWN,
        })
        .expect(201)
        .expect((res) => {
          expect(res.body).toHaveProperty('roundId');
          expect(res.body).toHaveProperty('startPrice');
          expect(res.body).toHaveProperty('endLedger');
          expect(res.body).toHaveProperty('mode');
          expect(res.body).toHaveProperty('createdAt');
          expect(res.body.mode).toBe(GameMode.UP_DOWN);
          expect(res.body.startPrice).toBeGreaterThan(0n);
          expect(res.body.endLedger).toBeGreaterThan(0);
          roundId = res.body.roundId;
        });

      await request(app)
        .get('/api/rounds/active')
        .expect(200)
        .expect((res) => {
          expect(res.body.roundId).toBe(roundId);
          expect(res.body).toHaveProperty('startPrice');
          expect(res.body).toHaveProperty('poolUp');
          expect(res.body).toHaveProperty('poolDown');
          expect(res.body).toHaveProperty('endLedger');
          expect(res.body).toHaveProperty('mode');
          expect(res.body.mode).toBe(GameMode.UP_DOWN);
        });

      const userASecret = 'S' + 'A'.repeat(55);
      await request(app)
        .post('/api/rounds/predict')
        .set('Authorization', `Bearer ${userAToken}`)
        .set('x-signature', userASecret)
        .send({
          roundId,
          side: BetSide.UP,
          amount: 100,
          mode: GameMode.UP_DOWN,
        })
        .expect(201)
        .expect((res) => {
          expect(res.body).toHaveProperty('predictionId');
          expect(res.body).toHaveProperty('roundId');
          expect(res.body).toHaveProperty('side');
          expect(res.body).toHaveProperty('amount');
          expect(res.body).toHaveProperty('txHash');
          expect(res.body.roundId).toBe(roundId);
          expect(res.body.side).toBe(BetSide.UP);
          expect(res.body.amount).toBe(100);
          predictionAId = res.body.predictionId;
        });

      const userBSecret = 'S' + 'B'.repeat(55);
      await request(app)
        .post('/api/rounds/predict')
        .set('Authorization', `Bearer ${userBToken}`)
        .set('x-signature', userBSecret)
        .send({
          roundId,
          side: BetSide.DOWN,
          amount: 150,
          mode: GameMode.UP_DOWN,
        })
        .expect(201)
        .expect((res) => {
          expect(res.body).toHaveProperty('predictionId');
          expect(res.body.roundId).toBe(roundId);
          expect(res.body.side).toBe(BetSide.DOWN);
          expect(res.body.amount).toBe(150);
          predictionBId = res.body.predictionId;
        });

      await request(app)
        .get('/api/rounds/active')
        .expect(200)
        .expect((res) => {
          const poolUp = BigInt(res.body.poolUp);
          const poolDown = BigInt(res.body.poolDown);
          expect(poolUp).toBeGreaterThan(0n);
          expect(poolDown).toBeGreaterThan(0n);
        });

      await request(app)
        .post('/api/rounds/resolve')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          roundId,
          finalPrice,
          mode: GameMode.UP_DOWN,
        })
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty('roundId');
          expect(res.body).toHaveProperty('outcome');
          expect(res.body).toHaveProperty('winnersCount');
          expect(res.body).toHaveProperty('losersCount');
          expect(res.body).toHaveProperty('txHash');
          expect(res.body.roundId).toBe(roundId);
          expect(res.body.outcome).toBe(BetSide.UP);
          expect(res.body.winnersCount).toBe(1);
          expect(res.body.losersCount).toBe(1);
          resolveTxHash = res.body.txHash;
        });

      expect(roundId).toBeDefined();
      expect(predictionAId).toBeDefined();
      expect(predictionBId).toBeDefined();
      expect(resolveTxHash).toBeDefined();
    });
  });

  describe('Validation Tests', () => {
    it('should reject start round without authentication', async () => {
      await request(app)
        .post('/api/rounds/start')
        .send({
          startPrice: '1.23',
          durationLedgers: 60,
          mode: GameMode.UP_DOWN,
        })
        .expect(401);
    });

    it('should reject prediction without authentication', async () => {
      await request(app)
        .post('/api/rounds/predict')
        .send({
          roundId: 'test-round-id',
          side: BetSide.UP,
          amount: 100,
          mode: GameMode.UP_DOWN,
        })
        .expect(401);
    });

    it('should reject prediction for non-existent round', async () => {
      await request(app)
        .post('/api/rounds/predict')
        .set('Authorization', `Bearer ${userAToken}`)
        .set('x-signature', 'S' + 'A'.repeat(55))
        .send({
          roundId: 'non-existent-round',
          side: BetSide.UP,
          amount: 100,
          mode: GameMode.UP_DOWN,
        })
        .expect(404);
    });

    it('should reject invalid bet amount', async () => {
      const { body: roundBody } = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          startPrice: '1.23',
          durationLedgers: 60,
          mode: GameMode.UP_DOWN,
        })
        .expect(201);

      await request(app)
        .post('/api/rounds/predict')
        .set('Authorization', `Bearer ${userAToken}`)
        .set('x-signature', 'S' + 'A'.repeat(55))
        .send({
          roundId: roundBody.roundId,
          side: BetSide.UP,
          amount: -10,
          mode: GameMode.UP_DOWN,
        })
        .expect(400);
    });

    it('should reject invalid side', async () => {
      const { body: roundBody } = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          startPrice: '1.23',
          durationLedgers: 60,
          mode: GameMode.UP_DOWN,
        })
        .expect(201);

      await request(app)
        .post('/api/rounds/predict')
        .set('Authorization', `Bearer ${userAToken}`)
        .set('x-signature', 'S' + 'A'.repeat(55))
        .send({
          roundId: roundBody.roundId,
          side: 'invalid',
          amount: 100,
          mode: GameMode.UP_DOWN,
        })
        .expect(400);
    });
  });

  describe('Legends Mode (Stubbed)', () => {
    it.skip('should handle Legends mode predictions - AWAITING CONTRACT SUPPORT', async () => {
      await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          startPrice: '1.23',
          durationLedgers: 60,
          mode: GameMode.LEGENDS,
        })
        .expect(201);
    });

    it('should return 501 for Legends mode start request', async () => {
      await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          startPrice: '1.23',
          durationLedgers: 60,
          mode: GameMode.LEGENDS,
        })
        .expect(501)
        .expect((res) => {
          expect(res.body).toHaveProperty('error');
          expect(res.body.error).toBe('Not Implemented');
          expect(res.body.message).toContain('Legends mode');
          expect(res.body.message).toContain('Xelma-Blockchain');
        });
    });

    it('should return 501 for Legends mode prediction request', async () => {
      await request(app)
        .post('/api/rounds/predict')
        .set('Authorization', `Bearer ${userAToken}`)
        .set('x-signature', 'S' + 'A'.repeat(55))
        .send({
          roundId: 'test-round-id',
          side: BetSide.UP,
          amount: 100,
          mode: GameMode.LEGENDS,
        })
        .expect(501)
        .expect((res) => {
          expect(res.body.error).toBe('Not Implemented');
          expect(res.body.message).toContain('Legends mode');
        });
    });

    it('should return 501 for Legends mode resolve request', async () => {
      await request(app)
        .post('/api/rounds/resolve')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          roundId: 'test-round-id',
          finalPrice: '1.45',
          mode: GameMode.LEGENDS,
        })
        .expect(501)
        .expect((res) => {
          expect(res.body.error).toBe('Not Implemented');
          expect(res.body.message).toContain('Legends mode');
        });
    });
  });

  describe('Sample Request/Response Payloads', () => {
    it('should provide correct sample payloads as documented', () => {
      expect(GameMode.UP_DOWN).toBe(0);
      expect(GameMode.LEGENDS).toBe(1);
      expect(BetSide.UP).toBe('up');
      expect(BetSide.DOWN).toBe('down');
    });
  });
});
