import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { prisma } from '../lib/prisma';
import request from 'supertest';
import { createApp } from '../index';
import { generateToken } from '../utils/jwt.util';
import { Express } from 'express';

describe('Concurrent Round Creation Prevention (Issue #66)', () => {
  let app: Express;
  let adminUser: any;
  let adminToken: string;

  beforeAll(async () => {
    app = createApp();

    adminUser = await prisma.user.create({
      data: {
        walletAddress: 'GADMIN_CONCURRENT_TEST_AAAAAAAAAA',
        role: 'ADMIN',
        virtualBalance: 1000,
      },
    });

    adminToken = generateToken(adminUser.id, adminUser.walletAddress);
  });

  afterAll(async () => {
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
      expect(res2.body.error).toContain('active');
      expect(res2.body.error).toContain('UP_DOWN');

      // Cleanup
      await prisma.round.delete({ where: { id: firstRoundId } });
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
      expect(res2.body.error).toContain('active');
      expect(res2.body.error).toContain('LEGENDS');

      // Cleanup
      await prisma.round.delete({ where: { id: firstRoundId } });
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
