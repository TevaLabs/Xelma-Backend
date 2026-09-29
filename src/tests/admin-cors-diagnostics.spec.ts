import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import { UserRole } from '@prisma/client';
import { createApp } from '../app-factory';
import { generateToken } from '../utils/jwt.util';
import { isCorsDiagnosticsEnabled } from '../utils/cors';
import { prisma } from '../lib/prisma';

jest.mock('../lib/prisma', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    auditLog: { create: jest.fn() },
  },
}));

jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockPrisma = prisma as any;

const TEST_JWT_SECRET = 'admin-cors-diagnostics-test-jwt-secret-key-2026';
process.env.JWT_SECRET = TEST_JWT_SECRET;

describe('CORS Diagnostics in Hackathon Mode (Issue #666)', () => {
  const originalEnv = { ...process.env };
  const ADMIN_ADDRESS = 'GADMIN_CORS_TEST_AAAAAAAAAAAAAAAAAAAAAA';
  const USER_ADDRESS = 'GUSER_CORS_TEST_BBBBBBBBBBBBBBBBBBBBBB';
  const ADMIN_TOKEN = generateToken('admin-id', ADMIN_ADDRESS, UserRole.ADMIN);
  const USER_TOKEN = generateToken('user-id', USER_ADDRESS, UserRole.USER);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    process.env.NODE_ENV = 'development';

    mockPrisma.user.findUnique.mockImplementation((args: any) => {
      const id = args?.where?.id ?? args?.where?.walletAddress;
      if (id === USER_ADDRESS || id === 'user-id') {
        return Promise.resolve({
          id: 'user-id',
          walletAddress: USER_ADDRESS,
          role: UserRole.USER,
        });
      }
      if (id === ADMIN_ADDRESS || id === 'admin-id') {
        return Promise.resolve({
          id: 'admin-id',
          walletAddress: ADMIN_ADDRESS,
          role: UserRole.ADMIN,
        });
      }
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('isCorsDiagnosticsEnabled helper', () => {
    it('defaults to false when ENABLE_CORS_DIAGNOSTICS is unset or empty', () => {
      expect(isCorsDiagnosticsEnabled({})).toBe(false);
      expect(isCorsDiagnosticsEnabled({ ENABLE_CORS_DIAGNOSTICS: '' })).toBe(false);
      expect(isCorsDiagnosticsEnabled({ ENABLE_CORS_DIAGNOSTICS: undefined })).toBe(false);
    });

    it('returns false when ENABLE_CORS_DIAGNOSTICS is false or 0', () => {
      expect(isCorsDiagnosticsEnabled({ ENABLE_CORS_DIAGNOSTICS: 'false' })).toBe(false);
      expect(isCorsDiagnosticsEnabled({ ENABLE_CORS_DIAGNOSTICS: '0' })).toBe(false);
      expect(isCorsDiagnosticsEnabled({ ENABLE_CORS_DIAGNOSTICS: 'FALSE' })).toBe(false);
    });

    it('returns true when ENABLE_CORS_DIAGNOSTICS is true or 1', () => {
      expect(isCorsDiagnosticsEnabled({ ENABLE_CORS_DIAGNOSTICS: 'true' })).toBe(true);
      expect(isCorsDiagnosticsEnabled({ ENABLE_CORS_DIAGNOSTICS: '1' })).toBe(true);
      expect(isCorsDiagnosticsEnabled({ ENABLE_CORS_DIAGNOSTICS: 'TRUE' })).toBe(true);
      expect(isCorsDiagnosticsEnabled({ ENABLE_CORS_DIAGNOSTICS: '  true  ' })).toBe(true);
    });
  });

  describe('Case 1: Flag OFF (ENABLE_CORS_DIAGNOSTICS=false or unset)', () => {
    it('returns 404 Not Found when ENABLE_CORS_DIAGNOSTICS is false', async () => {
      process.env.ENABLE_CORS_DIAGNOSTICS = 'false';
      const app = createApp({ mode: 'hackathon' });

      const res = await request(app)
        .get('/api/admin/cors-diagnostics')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(res.status).toBe(404);
    });

    it('returns 404 Not Found when ENABLE_CORS_DIAGNOSTICS is unset', async () => {
      delete process.env.ENABLE_CORS_DIAGNOSTICS;
      const app = createApp({ mode: 'hackathon' });

      const res = await request(app)
        .get('/api/admin/cors-diagnostics')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(res.status).toBe(404);
    });

    it('returns 404 Not Found for anonymous caller when flag is OFF', async () => {
      process.env.ENABLE_CORS_DIAGNOSTICS = 'false';
      const app = createApp({ mode: 'hackathon' });

      const res = await request(app).get('/api/admin/cors-diagnostics');
      expect(res.status).toBe(404);
    });
  });

  describe('Case 2: Flag ON + Missing / Non-Admin Authentication', () => {
    it('returns 401 Unauthorized when no Authorization header is provided', async () => {
      process.env.ENABLE_CORS_DIAGNOSTICS = 'true';
      const app = createApp({ mode: 'hackathon' });

      const res = await request(app).get('/api/admin/cors-diagnostics');

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('error');
    });

    it('returns 401 Unauthorized when Bearer token is invalid', async () => {
      process.env.ENABLE_CORS_DIAGNOSTICS = 'true';
      const app = createApp({ mode: 'hackathon' });

      const res = await request(app)
        .get('/api/admin/cors-diagnostics')
        .set('Authorization', 'Bearer invalid-token');

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('error');
    });

    it('returns 403 Forbidden when authenticated as non-admin user (USER role)', async () => {
      process.env.ENABLE_CORS_DIAGNOSTICS = 'true';
      const app = createApp({ mode: 'hackathon' });

      const res = await request(app)
        .get('/api/admin/cors-diagnostics')
        .set('Authorization', `Bearer ${USER_TOKEN}`);

      expect(res.status).toBe(403);
      expect(res.body).toHaveProperty('error');
    });
  });

  describe('Case 3: Flag ON + Valid Admin Authentication', () => {
    it('returns 200 OK with resolved CORS diagnostics payload for ADMIN', async () => {
      process.env.ENABLE_CORS_DIAGNOSTICS = 'true';
      process.env.CLIENT_URL = 'http://localhost:5173';
      process.env.ALLOWED_ORIGINS = 'https://app.xelma.com,https://staging.xelma.com';
      const app = createApp({ mode: 'hackathon' });

      const res = await request(app)
        .get('/api/admin/cors-diagnostics')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('env');
      expect(res.body.env).toEqual(
        expect.objectContaining({
          clientUrl: 'http://localhost:5173',
          allowedOrigins: ['https://app.xelma.com', 'https://staging.xelma.com'],
        }),
      );
      expect(res.body).toHaveProperty('http');
      expect(res.body).toHaveProperty('socket');
    });

    it('evaluates whether origin is allowed when ?origin= query parameter is provided', async () => {
      process.env.ENABLE_CORS_DIAGNOSTICS = 'true';
      process.env.CLIENT_URL = 'http://localhost:5173';
      process.env.ALLOWED_ORIGINS = 'https://app.xelma.com';
      const app = createApp({ mode: 'hackathon' });

      const allowedRes = await request(app)
        .get('/api/admin/cors-diagnostics?origin=https://app.xelma.com')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(allowedRes.status).toBe(200);
      expect(allowedRes.body.test).toEqual({
        origin: 'https://app.xelma.com',
        httpAllowed: true,
        socketAllowed: true,
      });

      const disallowedRes = await request(app)
        .get('/api/admin/cors-diagnostics?origin=https://malicious.example.com')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(disallowedRes.status).toBe(200);
      expect(disallowedRes.body.test).toEqual({
        origin: 'https://malicious.example.com',
        httpAllowed: false,
        socketAllowed: false,
      });
    });

    it('evaluates whether origin is allowed when request Origin header is sent', async () => {
      process.env.ENABLE_CORS_DIAGNOSTICS = 'true';
      process.env.CLIENT_URL = 'http://localhost:5173';
      const app = createApp({ mode: 'hackathon' });

      const res = await request(app)
        .get('/api/admin/cors-diagnostics')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
        .set('Origin', 'http://localhost:5173');

      expect(res.status).toBe(200);
      expect(res.body.test).toEqual({
        origin: 'http://localhost:5173',
        httpAllowed: true,
        socketAllowed: true,
      });
    });

    it('never leaks secret environment variables or credentials in payload', async () => {
      process.env.ENABLE_CORS_DIAGNOSTICS = 'true';
      process.env.JWT_SECRET = 'super-secret-jwt-key-not-to-leak';
      process.env.DATABASE_URL = 'postgresql://admin:secretpassword@db.xelma.com:5432/prod';
      process.env.SOROBAN_ADMIN_SECRET = 'SECRET_SOROBAN_KEY';
      const adminTokenWithNewSecret = generateToken('admin-id', ADMIN_ADDRESS, UserRole.ADMIN);
      const app = createApp({ mode: 'hackathon' });

      const res = await request(app)
        .get('/api/admin/cors-diagnostics')
        .set('Authorization', `Bearer ${adminTokenWithNewSecret}`);

      expect(res.status).toBe(200);
      const jsonString = JSON.stringify(res.body);
      expect(jsonString).not.toContain('super-secret-jwt-key');
      expect(jsonString).not.toContain('secretpassword');
      expect(jsonString).not.toContain('SECRET_SOROBAN_KEY');
    });
  });
});
