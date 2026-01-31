import { describe, it, expect, beforeAll } from '@jest/globals';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import app from '../index';
import { generateToken } from '../utils/jwt.util';
import sorobanService from '../services/soroban.service';
import { testUtils } from './setup';

const prisma = new PrismaClient();

describe('Soroban Integration - End-to-End Tests', () => {
  let adminUser: any;
  let oracleUser: any;
  let userA: any;
  let userB: any;
  let adminToken: string;
  let oracleToken: string;
  let userAToken: string;
  let userBToken: string;

  // Test wallet addresses (mock Stellar addresses)
  const ADMIN_WALLET = 'GADMIN' + 'A'.repeat(50);
  const ORACLE_WALLET = 'GORACLE' + 'B'.repeat(49);
  const USER_A_WALLET = 'GUSERA' + 'C'.repeat(50);
  const USER_B_WALLET = 'GUSERB' + 'D'.repeat(50);

  // Mock secret keys (for testing only)
  const USER_A_SECRET = 'SUSERA' + 'E'.repeat(50);
  const USER_B_SECRET = 'SUSERB' + 'F'.repeat(50);

  beforeAll(async () => {
    console.log('🧪 Creating test users...');

    // Create admin user
    adminUser = await testUtils.createTestUser(ADMIN_WALLET, 'ADMIN');
    adminToken = generateToken(adminUser.id, adminUser.walletAddress);

    // Create oracle user
    oracleUser = await testUtils.createTestUser(ORACLE_WALLET, 'ORACLE');
    oracleToken = generateToken(oracleUser.id, oracleUser.walletAddress);

    // Create regular users
    userA = await testUtils.createTestUser(USER_A_WALLET, 'USER');
    userAToken = generateToken(userA.id, userA.walletAddress);

    userB = await testUtils.createTestUser(USER_B_WALLET, 'USER');
    userBToken = generateToken(userB.id, userB.walletAddress);

    console.log('✅ Test users created');
    console.log(`   Admin: ${testUtils.maskWallet(ADMIN_WALLET)}`);
    console.log(`   Oracle: ${testUtils.maskWallet(ORACLE_WALLET)}`);
    console.log(`   User A: ${testUtils.maskWallet(USER_A_WALLET)}`);
    console.log(`   User B: ${testUtils.maskWallet(USER_B_WALLET)}`);
  });

  describe('Blockchain Service Status', () => {
    it('should return blockchain status', async () => {
      const response = await request(app)
        .get('/api/rounds/status/blockchain')
        .expect(200);

      expect(response.body).toHaveProperty('initialized');
      expect(typeof response.body.initialized).toBe('boolean');

      if (response.body.initialized) {
        console.log('✅ Soroban service is initialized');
        expect(response.body).toHaveProperty('network');
        expect(response.body).toHaveProperty('contractId');
      } else {
        console.log('⚠️  Soroban service NOT initialized (database-only mode)');
      }
    });
  });

  describe('Round Lifecycle - UP_DOWN Mode', () => {
    let roundId: string;

    it('should start a new UP_DOWN round (admin only)', async () => {
      const response = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 0, // UP_DOWN
          startPrice: 0.1234,
          duration: 300, // 5 minutes in seconds
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.round).toHaveProperty('id');
      expect(response.body.round.status).toBe('ACTIVE');
      expect(response.body.round.startPrice).toBeGreaterThan(0);

      roundId = response.body.round.id;
      console.log(`✅ Round created: ${roundId}`);
    });

    it('should NOT allow non-admin to start round', async () => {
      await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          mode: 0,
          startPrice: 0.1234,
          duration: 300,
        })
        .expect(403);
    });

    it('should submit prediction from User A (UP)', async () => {
      const response = await request(app)
        .post('/api/predictions/submit')
        .set('Authorization', `Bearer ${userAToken}`)
        .set('x-signature', USER_A_SECRET)
        .send({
          roundId,
          userId: userA.id,
          amount: 100,
          side: 'UP',
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.prediction).toHaveProperty('id');
      expect(response.body.prediction.side).toBe('UP');
      expect(response.body.prediction.amount).toBe(100);

      console.log(`✅ User A bet 100 on UP`);
    });

    it('should submit prediction from User B (DOWN)', async () => {
      const response = await request(app)
        .post('/api/predictions/submit')
        .set('Authorization', `Bearer ${userBToken}`)
        .set('x-signature', USER_B_SECRET)
        .send({
          roundId,
          userId: userB.id,
          amount: 150,
          side: 'DOWN',
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.prediction.side).toBe('DOWN');
      expect(response.body.prediction.amount).toBe(150);

      console.log(`✅ User B bet 150 on DOWN`);
    });

    it('should NOT allow double betting from same user', async () => {
      const response = await request(app)
        .post('/api/predictions/submit')
        .set('Authorization', `Bearer ${userAToken}`)
        .set('x-signature', USER_A_SECRET)
        .send({
          roundId,
          userId: userA.id,
          amount: 50,
          side: 'DOWN',
        })
        .expect(409);

      expect(response.body.error).toBeDefined();
      console.log(`✅ Double betting prevented`);
    });

    it('should resolve round with oracle (price went UP)', async () => {
      const response = await request(app)
        .post(`/api/rounds/${roundId}/resolve`)
        .set('Authorization', `Bearer ${oracleToken}`)
        .send({
          finalPrice: 0.2345, // Higher than 0.1234 = UP wins
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.round.status).toBe('RESOLVED');
      expect(response.body.round.endPrice).toBe(0.2345);
      expect(response.body.round.winners).toBe(1); // User A won

      console.log(`✅ Round resolved: UP won (User A wins)`);
    });

    it('should verify winner received payout', async () => {
      const updatedUserA = await prisma.user.findUnique({
        where: { id: userA.id },
      });

      expect(updatedUserA).toBeDefined();
      // User A started with 1000, bet 100, won back 100 + share of 150
      expect(updatedUserA!.virtualBalance).toBeGreaterThan(1000);
      expect(updatedUserA!.wins).toBe(1);
      expect(updatedUserA!.streak).toBeGreaterThan(0);

      console.log(`✅ User A received payout: ${updatedUserA!.virtualBalance}`);
    });
  });

  describe('Error Handling', () => {
    it('should return 400 for invalid start price', async () => {
      await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 0,
          startPrice: -1,
          duration: 300,
        })
        .expect(400);
    });

    it('should return 400 for invalid duration', async () => {
      await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 0,
          startPrice: 0.1234,
          duration: 0,
        })
        .expect(400);
    });

    it('should return 400 for insufficient balance', async () => {
      // Create a round first
      const roundResponse = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 0,
          startPrice: 0.1234,
          duration: 300,
        });

      const roundId = roundResponse.body.round.id;

      // Try to bet more than balance
      await request(app)
        .post('/api/predictions/submit')
        .set('Authorization', `Bearer ${userAToken}`)
        .set('x-signature', USER_A_SECRET)
        .send({
          roundId,
          userId: userA.id,
          amount: 999999, // Way more than balance
          side: 'UP',
        })
        .expect(400);
    });

    it('should return 401 for missing authentication', async () => {
      await request(app)
        .post('/api/rounds/start')
        .send({
          mode: 0,
          startPrice: 0.1234,
          duration: 300,
        })
        .expect(401);
    });

    it('should return 404 for non-existent round', async () => {
      await request(app)
        .get('/api/rounds/non-existent-round-id')
        .expect(404);
    });
  });

  describe('LEGENDS Mode (Not Yet Implemented)', () => {
    it('should return 501 for LEGENDS mode start', async () => {
      const response = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 1, // LEGENDS
          startPrice: 0.1234,
          duration: 300,
        })
        .expect(501);

      expect(response.body.error).toBe('LEGENDS_NOT_IMPLEMENTED');
      expect(response.body.message).toContain('LEGENDS mode');

      console.log('✅ LEGENDS mode correctly returns 501');
    });
  });

  describe('Active Round Conflict', () => {
    it('should prevent creating multiple active rounds', async () => {
      // Create first round
      await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 0,
          startPrice: 0.1234,
          duration: 300,
        })
        .expect(200);

      // Try to create second round
      const response = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 0,
          startPrice: 0.2345,
          duration: 300,
        })
        .expect(409);

      expect(response.body.error).toBe('ACTIVE_ROUND_EXISTS');
      console.log('✅ Multiple active rounds prevented');
    });
  });

  describe('Authorization Checks', () => {
    it('should require admin for starting rounds', async () => {
      await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          mode: 0,
          startPrice: 0.1234,
          duration: 300,
        })
        .expect(403);
    });

    it('should require oracle for resolving rounds', async () => {
      // Create a round first
      const roundResponse = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 0,
          startPrice: 0.1234,
          duration: 300,
        });

      const roundId = roundResponse.body.round.id;

      // Try to resolve as regular user
      await request(app)
        .post(`/api/rounds/${roundId}/resolve`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          finalPrice: 0.2345,
        })
        .expect(403);
    });

    it('should require authentication for predictions', async () => {
      // Create a round first
      const roundResponse = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 0,
          startPrice: 0.1234,
          duration: 300,
        });

      const roundId = roundResponse.body.round.id;

      // Try to predict without auth
      await request(app)
        .post('/api/predictions/submit')
        .send({
          roundId,
          userId: userA.id,
          amount: 100,
          side: 'UP',
        })
        .expect(401);
    });
  });
});