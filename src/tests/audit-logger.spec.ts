import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { auditLogger, AuditEventType, AuditSeverity } from '../utils/audit-logger';
import logger from '../utils/logger';
import { prisma } from '../lib/prisma';

// Mock the logger
jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Mock the prisma client
jest.mock('../lib/prisma', () => ({
  prisma: {
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-123' }),
    },
  },
}));

const mockAuditLogCreate = prisma.auditLog.create as any;

describe('AuditLogger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuditLogCreate.mockResolvedValue({ id: 'audit-123' });
  });

  describe('logChallengeIssued', () => {
    it('should log challenge issued event with all metadata', async () => {
      const expiresAt = new Date('2026-12-31T23:59:59.000Z');
      
      auditLogger.logChallengeIssued({
        walletAddress: 'GTEST123',
        challengeId: 'challenge-123',
        expiresAt,
        requestId: 'req-123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          audit: true,
          eventType: AuditEventType.CHALLENGE_ISSUED,
          severity: AuditSeverity.INFO,
          message: 'Authentication challenge issued',
          outcome: 'success',
          actor: expect.objectContaining({
            type: 'anonymous',
            walletAddress: 'GTEST123',
            ipAddress: '192.168.1.1',
            userAgent: 'Mozilla/5.0',
          }),
          context: expect.objectContaining({
            requestId: 'req-123',
            endpoint: '/api/auth/challenge',
            method: 'POST',
          }),
          resource: expect.objectContaining({
            type: 'challenge',
            id: 'challenge-123',
            walletAddress: 'GTEST123',
          }),
          metadata: expect.objectContaining({
            expiresAt: expiresAt.toISOString(),
          }),
        })
      );
      // Wait for the async persistToDatabase call to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      // Verify database persistence was called
      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventType: AuditEventType.CHALLENGE_ISSUED,
            actorType: 'anonymous',
            walletAddress: 'GTEST123',
          }),
        })
      );
    });

    it('should include TTL in metadata', () => {
      const expiresAt = new Date(Date.now() + 300000); // 5 minutes from now
      
      auditLogger.logChallengeIssued({
        walletAddress: 'GTEST123',
        challengeId: 'challenge-123',
        expiresAt,
      });

      const call = (logger.info as jest.Mock).mock.calls[0][0] as any;
      expect(call.metadata.ttlSeconds).toBeGreaterThan(0);
      expect(call.metadata.ttlSeconds).toBeLessThanOrEqual(300);
    });
  });

  describe('logChallengeVerified', () => {
    it('should log successful challenge verification', () => {
      auditLogger.logChallengeVerified({
        walletAddress: 'GTEST123',
        userId: 'user-123',
        challengeId: 'challenge-123',
        isNewUser: false,
        requestId: 'req-123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          audit: true,
          eventType: AuditEventType.CHALLENGE_VERIFIED,
          severity: AuditSeverity.INFO,
          message: 'Authentication challenge verified successfully',
          outcome: 'success',
          actor: expect.objectContaining({
            type: 'user',
            walletAddress: 'GTEST123',
            userId: 'user-123',
          }),
          metadata: expect.objectContaining({
            isNewUser: false,
            authMethod: 'wallet_signature',
          }),
        })
      );
    });

    it('should mark new user in metadata', () => {
      auditLogger.logChallengeVerified({
        walletAddress: 'GTEST123',
        userId: 'user-123',
        challengeId: 'challenge-123',
        isNewUser: true,
      });

      const call = (logger.info as jest.Mock).mock.calls[0][0] as any;
      expect(call.metadata.isNewUser).toBe(true);
    });
  });

  describe('logChallengeFailed', () => {
    it('should log failed challenge with invalid signature reason', () => {
      auditLogger.logChallengeFailed({
        walletAddress: 'GTEST123',
        challengeId: 'challenge-123',
        reason: 'invalid_signature',
        requestId: 'req-123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          audit: true,
          eventType: AuditEventType.CHALLENGE_FAILED,
          severity: AuditSeverity.WARNING,
          message: 'Authentication challenge verification failed: invalid_signature',
          outcome: 'failure',
          metadata: expect.objectContaining({
            failureReason: 'invalid_signature',
          }),
        })
      );
    });

    it('should log all failure reasons correctly', () => {
      const reasons: Array<'invalid_signature' | 'challenge_not_found' | 'challenge_expired' | 'challenge_used' | 'wallet_mismatch'> = [
        'invalid_signature',
        'challenge_not_found',
        'challenge_expired',
        'challenge_used',
        'wallet_mismatch',
      ];

      reasons.forEach((reason) => {
        jest.clearAllMocks();
        
        auditLogger.logChallengeFailed({
          walletAddress: 'GTEST123',
          reason,
        });

        const call = (logger.warn as jest.Mock).mock.calls[0][0] as any;
        expect(call.metadata.failureReason).toBe(reason);
        expect(call.message).toContain(reason);
      });
    });

    it('should handle missing challenge ID', () => {
      auditLogger.logChallengeFailed({
        walletAddress: 'GTEST123',
        reason: 'challenge_not_found',
      });

      const call = (logger.warn as jest.Mock).mock.calls[0][0] as any;
      expect(call.resource).toBeUndefined();
    });
  });

  describe('logChallengeExpired', () => {
    it('should log expired challenge with expiration details', () => {
      const expiresAt = new Date('2026-01-01T00:00:00.000Z');
      
      auditLogger.logChallengeExpired({
        walletAddress: 'GTEST123',
        challengeId: 'challenge-123',
        expiresAt,
        requestId: 'req-123',
        ipAddress: '192.168.1.1',
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          audit: true,
          eventType: AuditEventType.CHALLENGE_EXPIRED,
          severity: AuditSeverity.INFO,
          message: 'Authentication challenge expired',
          outcome: 'failure',
          metadata: expect.objectContaining({
            expiresAt: expiresAt.toISOString(),
            expiredSecondsAgo: expect.any(Number),
          }),
        })
      );
    });
  });

  describe('logChallengeInvalidated', () => {
    it('should log challenge invalidation with reason', () => {
      auditLogger.logChallengeInvalidated({
        walletAddress: 'GTEST123',
        challengeId: 'challenge-123',
        reason: 'used',
        requestId: 'req-123',
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          audit: true,
          eventType: AuditEventType.CHALLENGE_INVALIDATED,
          severity: AuditSeverity.INFO,
          message: 'Authentication challenge invalidated: used',
          outcome: 'success',
          actor: expect.objectContaining({
            type: 'system',
          }),
          metadata: expect.objectContaining({
            invalidationReason: 'used',
          }),
        })
      );
    });

    it('should log all invalidation reasons', () => {
      const reasons: Array<'used' | 'replaced' | 'cleanup'> = ['used', 'replaced', 'cleanup'];

      reasons.forEach((reason) => {
        jest.clearAllMocks();
        
        auditLogger.logChallengeInvalidated({
          walletAddress: 'GTEST123',
          challengeId: 'challenge-123',
          reason,
        });

        const call = (logger.info as jest.Mock).mock.calls[0][0] as any;
        expect(call.metadata.invalidationReason).toBe(reason);
      });
    });
  });

  describe('logChallengeReused', () => {
    it('should log challenge reuse attempt as warning', () => {
      const usedAt = new Date('2026-01-01T00:00:00.000Z');
      
      auditLogger.logChallengeReused({
        walletAddress: 'GTEST123',
        challengeId: 'challenge-123',
        usedAt,
        requestId: 'req-123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          audit: true,
          eventType: AuditEventType.CHALLENGE_REUSED,
          severity: AuditSeverity.WARNING,
          message: 'Attempt to reuse already-consumed authentication challenge',
          outcome: 'failure',
          metadata: expect.objectContaining({
            originalUsedAt: usedAt.toISOString(),
          }),
        })
      );
    });
  });

  describe('logSignatureInvalid', () => {
    it('should log invalid signature as warning', () => {
      auditLogger.logSignatureInvalid({
        walletAddress: 'GTEST123',
        reason: 'invalid_signature_format',
        requestId: 'req-123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          audit: true,
          eventType: AuditEventType.SIGNATURE_INVALID,
          severity: AuditSeverity.WARNING,
          message: 'Invalid wallet signature detected',
          outcome: 'failure',
          metadata: expect.objectContaining({
            failureReason: 'invalid_signature_format',
          }),
        })
      );
    });
  });

  describe('logAuthSuccess', () => {
    it('should log successful authentication', () => {
      auditLogger.logAuthSuccess({
        walletAddress: 'GTEST123',
        userId: 'user-123',
        requestId: 'req-123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          audit: true,
          eventType: AuditEventType.AUTH_SUCCESS,
          severity: AuditSeverity.INFO,
          message: 'User authenticated successfully',
          outcome: 'success',
          actor: expect.objectContaining({
            type: 'user',
            walletAddress: 'GTEST123',
            userId: 'user-123',
          }),
        })
      );
    });
  });

  describe('logAuthFailed', () => {
    it('should log authentication failure', () => {
      auditLogger.logAuthFailed({
        walletAddress: 'GTEST123',
        reason: 'invalid_credentials',
        requestId: 'req-123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      });

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          audit: true,
          eventType: AuditEventType.AUTH_FAILED,
          severity: AuditSeverity.ERROR,
          message: 'Authentication failed',
          outcome: 'failure',
          metadata: expect.objectContaining({
            failureReason: 'invalid_credentials',
          }),
        })
      );
    });
  });

  describe('logUserCreated', () => {
    it('should log user creation', () => {
      auditLogger.logUserCreated({
        walletAddress: 'GTEST123',
        userId: 'user-123',
        requestId: 'req-123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          audit: true,
          eventType: AuditEventType.USER_CREATED,
          severity: AuditSeverity.INFO,
          message: 'New user account created',
          outcome: 'success',
          actor: expect.objectContaining({
            type: 'system',
          }),
          resource: expect.objectContaining({
            type: 'user',
            id: 'user-123',
            walletAddress: 'GTEST123',
          }),
        })
      );
    });
  });

  describe('logUserLogin', () => {
    it('should log user login', () => {
      auditLogger.logUserLogin({
        walletAddress: 'GTEST123',
        userId: 'user-123',
        requestId: 'req-123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        streak: 5,
        bonusAwarded: true,
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          audit: true,
          eventType: AuditEventType.USER_LOGIN,
          severity: AuditSeverity.INFO,
          message: 'User logged in',
          outcome: 'success',
          actor: expect.objectContaining({
            type: 'user',
            walletAddress: 'GTEST123',
            userId: 'user-123',
          }),
          resource: expect.objectContaining({
            type: 'user',
            id: 'user-123',
            walletAddress: 'GTEST123',
          }),
          metadata: expect.objectContaining({
            streak: 5,
            bonusAwarded: true,
          }),
        })
      );
    });
  });

  describe('Database Persistence', () => {
    it('should persist audit event to database when enabled', async () => {
      const expiresAt = new Date('2026-12-31T23:59:59.000Z');
      
      auditLogger.logChallengeIssued({
        walletAddress: 'GTEST123',
        challengeId: 'challenge-123',
        expiresAt,
        requestId: 'req-123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      });

      // Wait for the async persistToDatabase call to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventType: AuditEventType.CHALLENGE_ISSUED,
            severity: AuditSeverity.INFO,
            message: 'Authentication challenge issued',
            outcome: 'success',
            actorType: 'anonymous',
            walletAddress: 'GTEST123',
            ipAddress: '192.168.1.1',
            userAgent: 'Mozilla/5.0',
            requestId: 'req-123',
            endpoint: '/api/auth/challenge',
            method: 'POST',
            resourceType: 'challenge',
            resourceId: 'challenge-123',
            resourceWalletAddress: 'GTEST123',
          }),
        })
      );
    });

    it('should not persist audit event to database when disabled', async () => {
      const originalEnv = process.env.AUDIT_LOG_DATABASE_ENABLED;
      process.env.AUDIT_LOG_DATABASE_ENABLED = 'false';

      auditLogger.logChallengeIssued({
        walletAddress: 'GTEST123',
        challengeId: 'challenge-123',
        expiresAt: new Date(),
      });

      // Wait for the async persistToDatabase call to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockAuditLogCreate).not.toHaveBeenCalled();

      // Restore original environment variable
      if (originalEnv !== undefined) {
        process.env.AUDIT_LOG_DATABASE_ENABLED = originalEnv;
      } else {
        delete process.env.AUDIT_LOG_DATABASE_ENABLED;
      }
    });

    it('should handle database errors gracefully', async () => {
      mockAuditLogCreate.mockRejectedValue(new Error('Database connection failed'));

      auditLogger.logChallengeIssued({
        walletAddress: 'GTEST123',
        challengeId: 'challenge-123',
        expiresAt: new Date(),
      });

      // Wait for the async persistToDatabase call to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      // Error should be logged but not thrown
      expect(logger.error).toHaveBeenCalled();
    });

    it('should map all audit event fields correctly to database model', async () => {
      const expiresAt = new Date('2026-12-31T23:59:59.000Z');
      
      auditLogger.logChallengeVerified({
        walletAddress: 'GTEST123',
        userId: 'user-123',
        challengeId: 'challenge-123',
        isNewUser: true,
        requestId: 'req-123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      });

      // Wait for the async persistToDatabase call to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventType: AuditEventType.CHALLENGE_VERIFIED,
            severity: AuditSeverity.INFO,
            message: 'Authentication challenge verified successfully',
            outcome: 'success',
            actorType: 'user',
            walletAddress: 'GTEST123',
            userId: 'user-123',
            ipAddress: '192.168.1.1',
            userAgent: 'Mozilla/5.0',
            requestId: 'req-123',
            sessionId: undefined,
            endpoint: '/api/auth/connect',
            method: 'POST',
            resourceType: 'challenge',
            resourceId: 'challenge-123',
            resourceWalletAddress: 'GTEST123',
            metadata: expect.objectContaining({
              isNewUser: true,
              authMethod: 'wallet_signature',
            }),
            timestamp: expect.any(Date),
          }),
        })
      );
    });
  });
});
