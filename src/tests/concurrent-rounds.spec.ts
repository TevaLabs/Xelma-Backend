import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { prisma } from '../lib/prisma';
import request from 'supertest';
import { createApp } from '../index';
import { generateToken } from '../utils/jwt.util';
import { Express } from 'express';
import { UserRole } from '@prisma/client';
import { adminRoundRateLimiter } from '../middleware/rateLimiter.middleware';

describe('Concurrent Round Creation Prevention (Issue #66)', () => {
  let app: Express;
  let adminUser: any;
  let adminToken: string;

  beforeEach(async () => {
    // Reset rate limiter for the test IP to allow rapid sequential requests
    adminRoundRateLimiter.resetKey('unknown'); 
    adminRoundRateLimiter.resetKey(adminUser?.id || 'unknown');
    adminRoundRateLimiter.resetKey('::ffff:127.0.0.1');
    adminRoundRateLimiter.resetKey('127.0.0.1');
    adminRoundRateLimiter.resetKey('::1');
    
    // Clear predictions and then rounds to ensure a pristine state for each test
    // This avoid Foreign key constraint violations.
    await prisma.prediction.deleteMany({});
    await prisma.round.deleteMany({});
  });

  beforeAll(async () => {
    app = createApp();

    // Clean up first in case of dirty state
    await prisma.prediction.deleteMany({});
    await prisma.round.deleteMany({});

    adminUser = await prisma.user.upsert({
      where: { walletAddress: 'GADMIN_CONCURRENT_TEST_AAAAAAAAAA' },
      update: { role: UserRole.ADMIN },
      create: {
        walletAddress: 'GADMIN_CONCURRENT_TEST_AAAAAAAAAA',
        role: UserRole.ADMIN,
        virtualBalance: 1000,
      },
    });

    adminToken = generateToken(adminUser.id, adminUser.walletAddress, UserRole.ADMIN);
  });

  afterAll(async () => {
    await prisma.prediction.deleteMany({});
    await prisma.round.deleteMany({});
    await prisma.user.deleteMany({ where: { id: adminUser.id } });
    await prisma.$disconnect();
  });

  describe('POST /api/rounds/start - concurrent round prevention', () => {
    it('should prevent creating second active UP_DOWN round', async () => {
      // Create first round
      const res1 = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 0,
          startPrice: 0.1234,
          duration: 300,
        });

      expect(res1.status).toBe(200);
      expect(res1.body.success).toBe(true);
      const firstRoundId = res1.body.round.id;

      // Attempt to create second round immediately
      const res2 = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 0,
          startPrice: 0.1235,
          duration: 300,
        });

      expect(res2.status).toBe(409);
      expect(res2.body.message).toContain('active');
      expect(res2.body.message).toContain('UP_DOWN');

      // Cleanup
      await prisma.round.deleteMany({ where: { id: firstRoundId } });
    });

    it('should prevent creating second active LEGENDS round', async () => {
      // Create first LEGENDS round
      const res1 = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 1,
          startPrice: 0.1234,
          duration: 300,
        });

      expect(res1.status).toBe(200);
      expect(res1.body.success).toBe(true);
      const firstRoundId = res1.body.round.id;

      // Attempt to create second LEGENDS round
      const res2 = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 1,
          startPrice: 0.1235,
          duration: 300,
        });

      expect(res2.status).toBe(409);
      expect(res2.body.message).toContain('active');
      expect(res2.body.message).toContain('LEGENDS');

      // Cleanup
      await prisma.round.deleteMany({ where: { id: firstRoundId } });
    });

    it('serialises two concurrent starts for the same mode (one 200, one 409)', async () => {
      const start = (startPrice: number) =>
        request(app)
          .post('/api/rounds/start')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ mode: 0, startPrice, duration: 300 });

      // Fire both without awaiting the first: previously both requests could
      // pass the un-locked findFirst check and each insert an ACTIVE round.
      const [first, second] = await Promise.all([start(0.1234), start(0.1235)]);

      expect([first.status, second.status].sort()).toEqual([200, 409]);
      const loser = first.status === 409 ? first : second;
      expect(loser.body.message).toContain('active');
      expect(loser.body.message).toContain('UP_DOWN');

      // Exactly one ACTIVE UP_DOWN round survived the race.
      const active = await prisma.round.findMany({
        where: { mode: 'UP_DOWN' as any, status: 'ACTIVE' as any },
      });
      expect(active).toHaveLength(1);
    });

    it('should allow creating UP_DOWN and LEGENDS rounds simultaneously', async () => {
      // Create UP_DOWN round
      const res1 = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 0,
          startPrice: 0.1234,
          duration: 300,
        });

      expect(res1.status).toBe(200);
      const upDownRoundId = res1.body.round.id;

      // Create LEGENDS round (should succeed - different mode)
      const res2 = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 1,
          startPrice: 0.1235,
          duration: 300,
        });

      expect(res2.status).toBe(200);
      expect(res2.body.success).toBe(true);
      const legendsRoundId = res2.body.round.id;

      // Cleanup
      await prisma.round.deleteMany({
        where: { id: { in: [upDownRoundId, legendsRoundId] } },
      });
    });

    it('should allow creating new round after previous is locked', async () => {
      // Create first round
      const res1 = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 0,
          startPrice: 0.1234,
          duration: 300,
        });

      expect(res1.status).toBe(200);
      const firstRoundId = res1.body.round.id;

      // Lock the first round
      await prisma.round.update({
        where: { id: firstRoundId },
        data: { status: 'LOCKED' },
      });

      // Create second round (should succeed - first is locked)
      const res2 = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 0,
          startPrice: 0.1235,
          duration: 300,
        });

      expect(res2.status).toBe(200);
      expect(res2.body.success).toBe(true);

      // Cleanup
      await prisma.round.deleteMany({
        where: { id: { in: [firstRoundId, res2.body.round.id] } },
      });
    });
  });
});
