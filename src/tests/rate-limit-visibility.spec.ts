import request from 'supertest';
import { createApp } from '../index';
import { prisma } from '../lib/prisma';
import { generateToken } from '../utils/jwt.util';
import { UserRole } from '@prisma/client';
import { rateLimitMetricsService } from '../services/rate-limit-metrics.service';

describe('Rate Limit Visibility', () => {
  let app: any;
  let adminToken: string;
  let userToken: string;
  let adminUser: any;
  let regularUser: any;

  beforeAll(async () => {
    app = createApp();

    // Create a mock admin user
    adminUser = await prisma.user.upsert({
      where: { walletAddress: 'GADMN123' },
      update: { role: UserRole.ADMIN },
      create: {
        walletAddress: 'GADMN123',
        role: UserRole.ADMIN,
        nickname: 'Admin',
      },
    });
    adminToken = generateToken(adminUser.id, adminUser.walletAddress, UserRole.ADMIN);

    // Create a mock regular user
    regularUser = await prisma.user.upsert({
      where: { walletAddress: 'GUSER123' },
      update: { role: UserRole.USER },
      create: {
        walletAddress: 'GUSER123',
        role: UserRole.USER,
        nickname: 'User',
      },
    });
    userToken = generateToken(regularUser.id, regularUser.walletAddress, UserRole.USER);
  });


  afterAll(async () => {
    await prisma.rateLimitMetric.deleteMany();
    // Don't delete users as they might be used by other tests if they share the same DB
    await prisma.$disconnect();
  });

  it('should record a rate limit hit in the database', async () => {
    // Record a hit manually through the service
    await rateLimitMetricsService.recordHit({
      endpoint: 'test/endpoint',
      key: 'test-key',
      ip: '127.0.0.1',
      userId: regularUser.id,
    });

    const metrics = await prisma.rateLimitMetric.findMany({
      where: { endpoint: 'test/endpoint' },
    });

    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics[0].endpoint).toBe('test/endpoint');
    expect(metrics[0].key).toBe('test-key');
  });

  it('should expose rate limit metrics to admins', async () => {
    const response = await request(app)
      .get('/api/admin/metrics/rate-limits')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('topEndpoints');
    expect(response.body).toHaveProperty('topAbusers');
    expect(response.body).toHaveProperty('recentEvents');
    expect(response.body).toHaveProperty('suspiciousActivity');
    expect(response.body.suspiciousActivity).toHaveProperty('byCategory');
    expect(response.body.suspiciousActivity).toHaveProperty('flaggedActors');
  });

  it('should deny access to rate limit metrics for regular users', async () => {
    const response = await request(app)
      .get('/api/admin/metrics/rate-limits')
      .set('Authorization', `Bearer ${userToken}`);

    expect(response.status).toBe(403);
  });

  it('should deny access to rate limit metrics for unauthenticated users', async () => {
    const response = await request(app)
      .get('/api/admin/metrics/rate-limits');

    expect(response.status).toBe(401);
  });

  it('should allow admins to clear old metrics', async () => {
    const response = await request(app)
      .post('/api/admin/metrics/rate-limits/clear?days=0')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('deletedCount');
  });
});
