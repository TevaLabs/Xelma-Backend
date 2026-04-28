import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { auditLogger, AuditEventType, AuditSeverity } from '../utils/audit-logger';
import logger from '../utils/logger';

// Mock the logger
jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('AuditLogger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('logChallengeIssued', () => {
    it('should log challenge issued event with all metadata', () => {
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
    });

    it('should include TTL in metadata', () => {
      const expiresAt = new Date(Date.now() + 300000); // 5 minutes from now
      
      auditLogger.logChallengeIssued({
        walletAddress: 'GTEST123',
        challengeId: 'challenge-123',
        expiresAt,
      });

      const call = (logger.info as jest.Mock).mock.calls[0][0];
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

      const call = (logger.info as jest.Mock).mock.calls[0][0];
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

        const call = (logger.warn as jest.Mock).mock.calls[0][0];
        expect(call.metadata.failureReason).toBe(reason);
        expect(call.message).toContain(reason);
      });
    });

    it('should handle missing challenge ID', () => {
      auditLogger.logChallengeFailed({
        walletAddress: 'GTEST123',
        reason: 'challenge_not_found',
      });

      const call = (logger.warn as jest.Mock).mock.calls[0][0];
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

        const call = (logger.info as jest.Mock).mock.calls[0][0];
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
            secondsSinceUsed: expect.any(Number),
          }),
        })
      );
    });
  });

  describe('logInvalidSignature', () => {
    it('should log invalid signature as warning', () => {
      auditLogger.logInvalidSignature({
        walletAddress: 'GTEST123',
        challengeId: 'challenge-123',
        requestId: 'req-123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          audit: true,
          eventType: AuditEventType.SIGNATURE_INVALID,
          severity: AuditSeverity.WARNING,
          message: 'Invalid signature provided for authentication challenge',
          outcome: 'failure',
          metadata: expect.objectContaining({
            verificationMethod: 'stellar_sdk',
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
        isNewUser: false,
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
            userId: 'user-123',
          }),
        })
      );
    });
  });

  describe('logUserCreated', () => {
    it('should log new user creation', () => {
      auditLogger.logUserCreated({
        walletAddress: 'GTEST123',
        userId: 'user-123',
        requestId: 'req-123',
        ipAddress: '192.168.1.1',
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
          }),
          metadata: expect.objectContaining({
            registrationMethod: 'wallet_authentication',
          }),
        })
      );
    });
  });

  describe('logUserLogin', () => {
    it('should log user login with streak and bonus', () => {
      auditLogger.logUserLogin({
        walletAddress: 'GTEST123',
        userId: 'user-123',
        streak: 5,
        bonusAwarded: 150,
        requestId: 'req-123',
        ipAddress: '192.168.1.1',
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          audit: true,
          eventType: AuditEventType.USER_LOGIN,
          severity: AuditSeverity.INFO,
          message: 'User logged in',
          outcome: 'success',
          metadata: expect.objectContaining({
            streak: 5,
            bonusAwarded: 150,
          }),
        })
      );
    });
  });

  describe('Security and sanitization', () => {
    it('should not include sensitive data in logs', () => {
      auditLogger.logChallengeIssued({
        walletAddress: 'GTEST123',
        challengeId: 'challenge-123',
        expiresAt: new Date(),
      });

      const call = (logger.info as jest.Mock).mock.calls[0][0];
      
      // Should not include challenge value, signatures, or tokens
      expect(JSON.stringify(call)).not.toContain('signature');
      expect(JSON.stringify(call)).not.toContain('token');
      expect(JSON.stringify(call)).not.toContain('password');
    });

    it('should truncate long user agents', () => {
      const longUserAgent = 'A'.repeat(300);
      
      auditLogger.logChallengeIssued({
        walletAddress: 'GTEST123',
        challengeId: 'challenge-123',
        expiresAt: new Date(),
        userAgent: longUserAgent,
      });

      const call = (logger.info as jest.Mock).mock.calls[0][0];
      expect(call.actor.userAgent.length).toBeLessThanOrEqual(200);
    });

    it('should include correlation identifiers', () => {
      auditLogger.logChallengeIssued({
        walletAddress: 'GTEST123',
        challengeId: 'challenge-123',
        expiresAt: new Date(),
        requestId: 'req-123',
      });

      const call = (logger.info as jest.Mock).mock.calls[0][0];
      expect(call.context.requestId).toBe('req-123');
      expect(call.resource.id).toBe('challenge-123');
    });
  });

  describe('Log structure', () => {
    it('should include all required fields', () => {
      auditLogger.logChallengeIssued({
        walletAddress: 'GTEST123',
        challengeId: 'challenge-123',
        expiresAt: new Date(),
      });

      const call = (logger.info as jest.Mock).mock.calls[0][0];
      
      // Required fields
      expect(call).toHaveProperty('audit', true);
      expect(call).toHaveProperty('eventType');
      expect(call).toHaveProperty('severity');
      expect(call).toHaveProperty('message');
      expect(call).toHaveProperty('outcome');
      expect(call).toHaveProperty('actor');
      expect(call).toHaveProperty('context');
      expect(call).toHaveProperty('timestamp');
    });

    it('should use correct severity levels', () => {
      // Info level
      auditLogger.logChallengeIssued({
        walletAddress: 'GTEST123',
        challengeId: 'challenge-123',
        expiresAt: new Date(),
      });
      expect(logger.info).toHaveBeenCalled();
      jest.clearAllMocks();

      // Warning level
      auditLogger.logChallengeFailed({
        walletAddress: 'GTEST123',
        reason: 'invalid_signature',
      });
      expect(logger.warn).toHaveBeenCalled();
      jest.clearAllMocks();
    });
  });

  describe('Queryability', () => {
    it('should produce JSON-serializable output', () => {
      auditLogger.logChallengeIssued({
        walletAddress: 'GTEST123',
        challengeId: 'challenge-123',
        expiresAt: new Date(),
      });

      const call = (logger.info as jest.Mock).mock.calls[0][0];
      
      // Should be JSON serializable
      expect(() => JSON.stringify(call)).not.toThrow();
      
      const json = JSON.parse(JSON.stringify(call));
      expect(json.eventType).toBe(AuditEventType.CHALLENGE_ISSUED);
    });

    it('should have consistent field names for querying', () => {
      const events = [
        () => auditLogger.logChallengeIssued({
          walletAddress: 'GTEST123',
          challengeId: 'challenge-123',
          expiresAt: new Date(),
        }),
        () => auditLogger.logChallengeVerified({
          walletAddress: 'GTEST123',
          userId: 'user-123',
          challengeId: 'challenge-123',
          isNewUser: false,
        }),
        () => auditLogger.logAuthSuccess({
          walletAddress: 'GTEST123',
          userId: 'user-123',
          isNewUser: false,
        }),
      ];

      events.forEach((logEvent) => {
        jest.clearAllMocks();
        logEvent();
        
        const call = (logger.info as jest.Mock).mock.calls[0][0];
        
        // All events should have these fields
        expect(call).toHaveProperty('audit');
        expect(call).toHaveProperty('eventType');
        expect(call).toHaveProperty('actor.walletAddress');
        expect(call).toHaveProperty('context.timestamp');
      });
    });
  });
});
