import { describe, it, expect, jest, beforeEach, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import { prisma } from '../lib/prisma';
import logger from '../utils/logger';
import { auditLogger, AuditEventType } from '../utils/audit-logger';

// Mock the logger to capture audit events
jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Mock signature verification to control test outcomes
jest.mock('../services/stellar.service', () => ({
  verifySignature: jest.fn(),
}));

describe('Auth Routes - Audit Integration', () => {
  let app: any;
  
  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    app = require('../index').createApp();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    
    // Clean up test data
    await prisma.authChallenge.deleteMany({
      where: { walletAddress: { startsWith: 'GTEST' } },
    });
    await prisma.user.deleteMany({
      where: { walletAddress: { startsWith: 'GTEST' } },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('POST /api/auth/challenge', () => {
    it('should emit challenge issued audit event on success', async () => {
      const walletAddress = 'GTEST123CHALLENGE';
      
      const response = await request(app)
        .post('/api/auth/challenge')
        .send({ walletAddress })
        .expect(200);

      // Verify response
      expect(response.body).toHaveProperty('challenge');
      expect(response.body).toHaveProperty('expiresAt');

      // Verify audit event was logged
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          audit: true,
          eventType: AuditEventType.CHALLENGE_ISSUED,
          message: 'Authentication challenge issued',
          outcome: 'success',
          actor: expect.objectContaining({
            type: 'anonymous',
            walletAddress,
          }),
          context: expect.objectContaining({
            endpoint: '/api/auth/challenge',
            method: 'POST',
          }),
          resource: expect.objectContaining({
            type: 'challenge',
            walletAddress,
          }),
        })
      );
    });

    it('should emit challenge invalidated events when replacing existing challenges', async () => {
      const walletAddress = 'GTEST123REPLACE';
      
      // Create first challenge
      await request(app)
        .post('/api/auth/challenge')
        .send({ walletAddress })
        .expect(200);

      jest.clearAllMocks();

      // Create second challenge (should replace first)
      await request(app)
        .post('/api/auth/challenge')
        .send({ walletAddress })
        .expect(200);

      // Should have logged invalidation of old challenge
      const logCalls = (logger.info as jest.Mock).mock.calls;
      const invalidationEvent = logCalls.find((call: any) => 
        call[0].eventType === AuditEventType.CHALLENGE_INVALIDATED
      );

      expect(invalidationEvent).toBeDefined();
      expect(invalidationEvent![0]).toMatchObject({
        audit: true,
        eventType: AuditEventType.CHALLENGE_INVALIDATED,
        message: 'Authentication challenge invalidated: replaced',
        outcome: 'success',
        metadata: expect.objectContaining({
          invalidationReason: 'replaced',
        }),
      });
    });

    it('should include request metadata in audit events', async () => {
      const walletAddress = 'GTEST123METADATA';
      
      await request(app)
        .post('/api/auth/challenge')
        .set('User-Agent', 'Test-Agent/1.0')
        .set('X-Request-ID', 'test-request-123')
        .send({ walletAddress })
        .expect(200);

      const logCall = (logger.info as jest.Mock).mock.calls[0][0] as any;
      
      expect(logCall.actor.userAgent).toBe('Test-Agent/1.0');
      expect(logCall.context.requestId).toBe('test-request-123');
      expect(logCall.actor.ipAddress).toBeDefined();
    });
  });

  describe('POST /api/auth/connect - Success Path', () => {
    beforeEach(() => {
      // Mock successful signature verification
      const { verifySignature } = require('../services/stellar.service');
      (verifySignature as jest.MockedFunction<any>).mockResolvedValue(true);
    });

    it('should emit complete audit trail for successful authentication', async () => {
      const walletAddress = 'GTEST123SUCCESS';
      
      // Step 1: Create challenge
      const challengeResponse = await request(app)
        .post('/api/auth/challenge')
        .send({ walletAddress })
        .expect(200);

      const { challenge } = challengeResponse.body;
      jest.clearAllMocks();

      // Step 2: Connect with valid signature
      await request(app)
        .post('/api/auth/connect')
        .send({
          walletAddress,
          challenge,
          signature: 'valid-signature',
        })
        .expect(200);

      // Verify all expected audit events were logged
      const logCalls = (logger.info as jest.Mock).mock.calls;
      const eventTypes = logCalls.map((call: any) => call[0].eventType);

      expect(eventTypes).toContain(AuditEventType.CHALLENGE_VERIFIED);
      expect(eventTypes).toContain(AuditEventType.AUTH_SUCCESS);
      expect(eventTypes).toContain(AuditEventType.USER_CREATED);
      expect(eventTypes).toContain(AuditEventType.USER_LOGIN);

      // Verify challenge verified event
      const challengeVerifiedEvent = logCalls.find((call: any) => 
        call[0].eventType === AuditEventType.CHALLENGE_VERIFIED
      );
      expect(challengeVerifiedEvent![0]).toMatchObject({
        audit: true,
        eventType: AuditEventType.CHALLENGE_VERIFIED,
        message: 'Authentication challenge verified successfully',
        outcome: 'success',
        metadata: expect.objectContaining({
          isNewUser: true,
          authMethod: 'wallet_signature',
        }),
      });

      // Verify user created event
      const userCreatedEvent = logCalls.find((call: any) => 
        call[0].eventType === AuditEventType.USER_CREATED
      );
      expect(userCreatedEvent![0]).toMatchObject({
        audit: true,
        eventType: AuditEventType.USER_CREATED,
        message: 'New user account created',
        outcome: 'success',
        actor: expect.objectContaining({
          type: 'system',
        }),
        metadata: expect.objectContaining({
          registrationMethod: 'wallet_authentication',
        }),
      });
    });

    it('should emit user login event for existing user', async () => {
      const walletAddress = 'GTEST123EXISTING';
      
      // Create user first
      await prisma.user.create({
        data: {
          walletAddress,
          publicKey: walletAddress,
          virtualBalance: 1000,
          streak: 3,
        },
      });

      // Create challenge
      const challengeResponse = await request(app)
        .post('/api/auth/challenge')
        .send({ walletAddress })
        .expect(200);

      const { challenge } = challengeResponse.body;
      jest.clearAllMocks();

      // Connect
      await request(app)
        .post('/api/auth/connect')
        .send({
          walletAddress,
          challenge,
          signature: 'valid-signature',
        })
        .expect(200);

      // Should not have user created event
      const logCalls = (logger.info as jest.Mock).mock.calls;
      const eventTypes = logCalls.map((call: any) => call[0].eventType);
      
      expect(eventTypes).not.toContain(AuditEventType.USER_CREATED);
      expect(eventTypes).toContain(AuditEventType.USER_LOGIN);

      // Verify login event has correct metadata
      const loginEvent = logCalls.find((call: any) => 
        call[0].eventType === AuditEventType.USER_LOGIN
      );
      expect((loginEvent![0] as any).metadata).toHaveProperty('streak');
      expect((loginEvent![0] as any).metadata).toHaveProperty('bonusAwarded');
    });

    it('should emit cleanup events for old challenges', async () => {
      const walletAddress = 'GTEST123CLEANUP';
      
      // Create old used challenge
      const oldChallenge = await prisma.authChallenge.create({
        data: {
          challenge: 'old-challenge-123',
          walletAddress,
          expiresAt: new Date(Date.now() + 300000),
          isUsed: true,
          usedAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25 hours ago
        },
      });

      // Create new challenge and connect
      const challengeResponse = await request(app)
        .post('/api/auth/challenge')
        .send({ walletAddress })
        .expect(200);

      const { challenge } = challengeResponse.body;
      jest.clearAllMocks();

      await request(app)
        .post('/api/auth/connect')
        .send({
          walletAddress,
          challenge,
          signature: 'valid-signature',
        })
        .expect(200);

      // Should have cleanup event
      const logCalls = (logger.info as jest.Mock).mock.calls;
      const cleanupEvent = logCalls.find((call: any) => 
        call[0].eventType === AuditEventType.CHALLENGE_INVALIDATED &&
        call[0].metadata?.invalidationReason === 'cleanup'
      );

      expect(cleanupEvent).toBeDefined();
      expect((cleanupEvent![0] as any).resource.id).toBe('old-challenge-123');
    });
  });

  describe('POST /api/auth/connect - Failure Paths', () => {
    beforeEach(() => {
      // Mock failed signature verification by default
      const { verifySignature } = require('../services/stellar.service');
      (verifySignature as jest.MockedFunction<any>).mockResolvedValue(false);
    });

    it('should emit challenge failed event for invalid signature', async () => {
      const walletAddress = 'GTEST123INVALID';
      
      // Create challenge
      const challengeResponse = await request(app)
        .post('/api/auth/challenge')
        .send({ walletAddress })
        .expect(200);

      const { challenge } = challengeResponse.body;
      jest.clearAllMocks();

      // Connect with invalid signature
      await request(app)
        .post('/api/auth/connect')
        .send({
          walletAddress,
          challenge,
          signature: 'invalid-signature',
        })
        .expect(401);

      // Should have logged invalid signature event
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          audit: true,
          eventType: AuditEventType.SIGNATURE_INVALID,
          message: 'Invalid signature provided for authentication challenge',
          outcome: 'failure',
          metadata: expect.objectContaining({
            verificationMethod: 'stellar_sdk',
          }),
        })
      );
    });

    it('should emit challenge failed event for non-existent challenge', async () => {
      const walletAddress = 'GTEST123NOTFOUND';
      
      await request(app)
        .post('/api/auth/connect')
        .send({
          walletAddress,
          challenge: 'non-existent-challenge',
          signature: 'some-signature',
        })
        .expect(401);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          audit: true,
          eventType: AuditEventType.CHALLENGE_FAILED,
          message: 'Authentication challenge verification failed: challenge_not_found',
          outcome: 'failure',
          metadata: expect.objectContaining({
            failureReason: 'challenge_not_found',
          }),
        })
      );
    });

    it('should emit challenge reused event for already used challenge', async () => {
      const walletAddress = 'GTEST123REUSED';
      
      // Create and use challenge
      const challengeResponse = await request(app)
        .post('/api/auth/challenge')
        .send({ walletAddress })
        .expect(200);

      const { challenge } = challengeResponse.body;
      
      // First use (successful)
      const { verifySignature } = require('../services/stellar.service');
      (verifySignature as jest.MockedFunction<any>).mockResolvedValue(true);
      
      await request(app)
        .post('/api/auth/connect')
        .send({
          walletAddress,
          challenge,
          signature: 'valid-signature',
        })
        .expect(200);

      jest.clearAllMocks();

      // Second use (should fail)
      await request(app)
        .post('/api/auth/connect')
        .send({
          walletAddress,
          challenge,
          signature: 'valid-signature',
        })
        .expect(401);

      // Should have logged reuse attempt
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          audit: true,
          eventType: AuditEventType.CHALLENGE_REUSED,
          message: 'Attempt to reuse already-consumed authentication challenge',
          outcome: 'failure',
          metadata: expect.objectContaining({
            originalUsedAt: expect.any(String),
            secondsSinceUsed: expect.any(Number),
          }),
        })
      );
    });

    it('should emit challenge expired event for expired challenge', async () => {
      const walletAddress = 'GTEST123EXPIRED';
      
      // Create expired challenge
      const expiredChallenge = await prisma.authChallenge.create({
        data: {
          challenge: 'expired-challenge-123',
          walletAddress,
          expiresAt: new Date(Date.now() - 1000), // 1 second ago
          isUsed: false,
        },
      });

      jest.clearAllMocks();

      await request(app)
        .post('/api/auth/connect')
        .send({
          walletAddress,
          challenge: expiredChallenge.challenge,
          signature: 'some-signature',
        })
        .expect(401);

      // Should have logged expiration event
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          audit: true,
          eventType: AuditEventType.CHALLENGE_EXPIRED,
          message: 'Authentication challenge expired',
          outcome: 'failure',
          metadata: expect.objectContaining({
            expiresAt: expect.any(String),
            expiredSecondsAgo: expect.any(Number),
          }),
        })
      );
    });

    it('should emit wallet mismatch event', async () => {
      const walletAddress1 = 'GTEST123WALLET1';
      const walletAddress2 = 'GTEST123WALLET2';
      
      // Create challenge for wallet1
      const challengeResponse = await request(app)
        .post('/api/auth/challenge')
        .send({ walletAddress: walletAddress1 })
        .expect(200);

      const { challenge } = challengeResponse.body;
      jest.clearAllMocks();

      // Try to use challenge with wallet2
      await request(app)
        .post('/api/auth/connect')
        .send({
          walletAddress: walletAddress2,
          challenge,
          signature: 'some-signature',
        })
        .expect(401);

      // Should have logged wallet mismatch
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          audit: true,
          eventType: AuditEventType.CHALLENGE_FAILED,
          message: 'Authentication challenge verification failed: wallet_mismatch',
          outcome: 'failure',
          metadata: expect.objectContaining({
            failureReason: 'wallet_mismatch',
          }),
        })
      );
    });
  });

  describe('Audit Event Structure Validation', () => {
    it('should include correlation identifiers in all events', async () => {
      const walletAddress = 'GTEST123CORRELATION';
      
      await request(app)
        .post('/api/auth/challenge')
        .set('X-Request-ID', 'correlation-test-123')
        .send({ walletAddress })
        .expect(200);

      const logCall = (logger.info as jest.Mock).mock.calls[0][0] as any;
      
      // Should have correlation identifiers
      expect(logCall.context.requestId).toBe('correlation-test-123');
      expect(logCall.resource.id).toBeDefined(); // challenge ID
      expect(logCall.resource.walletAddress).toBe(walletAddress);
    });

    it('should not include sensitive data in audit logs', async () => {
      const walletAddress = 'GTEST123SECURITY';
      
      const challengeResponse = await request(app)
        .post('/api/auth/challenge')
        .send({ walletAddress })
        .expect(200);

      const { challenge } = challengeResponse.body;
      
      // Mock successful verification
      const { verifySignature } = require('../services/stellar.service');
      (verifySignature as jest.Mock).mockResolvedValue(true);
      
      jest.clearAllMocks();

      await request(app)
        .post('/api/auth/connect')
        .send({
          walletAddress,
          challenge,
          signature: 'secret-signature-data',
        })
        .expect(200);

      // Check all log calls for sensitive data
      const allLogCalls = [
        ...(logger.info as jest.Mock).mock.calls,
        ...(logger.warn as jest.Mock).mock.calls,
        ...(logger.error as jest.Mock).mock.calls,
      ];

      allLogCalls.forEach(call => {
        const logString = JSON.stringify(call[0]);
        
        // Should not contain sensitive data
        expect(logString).not.toContain('secret-signature-data');
        expect(logString).not.toContain(challenge); // Challenge value itself
        expect(logString).not.toContain('password');
        expect(logString).not.toContain('token');
      });
    });

    it('should have queryable structure for observability tools', async () => {
      const walletAddress = 'GTEST123QUERYABLE';
      
      await request(app)
        .post('/api/auth/challenge')
        .send({ walletAddress })
        .expect(200);

      const logCall = (logger.info as jest.Mock).mock.calls[0][0] as any;
      
      // Should be JSON serializable
      expect(() => JSON.stringify(logCall)).not.toThrow();
      
      // Should have consistent structure for querying
      expect(logCall).toMatchObject({
        audit: true,
        eventType: expect.any(String),
        severity: expect.any(String),
        message: expect.any(String),
        outcome: expect.stringMatching(/^(success|failure)$/),
        actor: expect.objectContaining({
          type: expect.any(String),
        }),
        context: expect.objectContaining({
          timestamp: expect.any(String),
        }),
        timestamp: expect.any(String),
      });
    });
  });
});