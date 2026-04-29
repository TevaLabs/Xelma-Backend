/**
 * Audit Logger for Security-Critical Events
 * 
 * Provides structured audit logging for authentication and authorization events
 * with safe metadata (no secrets) and correlation identifiers.
 */

import logger from './logger';

/**
 * Audit event types for authentication lifecycle
 */
export enum AuditEventType {
  // Challenge lifecycle
  CHALLENGE_ISSUED = 'auth.challenge.issued',
  CHALLENGE_VERIFIED = 'auth.challenge.verified',
  CHALLENGE_FAILED = 'auth.challenge.failed',
  CHALLENGE_EXPIRED = 'auth.challenge.expired',
  CHALLENGE_INVALIDATED = 'auth.challenge.invalidated',
  CHALLENGE_REUSED = 'auth.challenge.reused',
  
  // Authentication events
  AUTH_SUCCESS = 'auth.success',
  AUTH_FAILED = 'auth.failed',
  SIGNATURE_INVALID = 'auth.signature.invalid',
  
  // User events
  USER_CREATED = 'auth.user.created',
  USER_LOGIN = 'auth.user.login',
}

/**
 * Audit event severity levels
 */
export enum AuditSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

/**
 * Actor information (who performed the action)
 */
export interface AuditActor {
  type: 'user' | 'system' | 'anonymous';
  walletAddress?: string;
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Context information (where/when the action occurred)
 */
export interface AuditContext {
  requestId?: string;
  sessionId?: string;
  endpoint?: string;
  method?: string;
  timestamp: string;
}

/**
 * Resource information (what was affected)
 */
export interface AuditResource {
  type: 'challenge' | 'user' | 'session';
  id?: string;
  walletAddress?: string;
}

/**
 * Audit event metadata (safe, no secrets)
 */
export interface AuditMetadata {
  [key: string]: string | number | boolean | null | undefined;
}

/**
 * Complete audit event structure
 */
export interface AuditEvent {
  eventType: AuditEventType;
  severity: AuditSeverity;
  message: string;
  actor: AuditActor;
  context: AuditContext;
  resource?: AuditResource;
  metadata?: AuditMetadata;
  outcome: 'success' | 'failure';
}

/**
 * Audit Logger Class
 */
class AuditLogger {
  /**
   * Log an audit event
   */
  log(event: AuditEvent): void {
    const logEntry = {
      audit: true,
      eventType: event.eventType,
      severity: event.severity,
      message: event.message,
      outcome: event.outcome,
      actor: this.sanitizeActor(event.actor),
      context: event.context,
      resource: event.resource,
      metadata: event.metadata,
      timestamp: event.context.timestamp,
    };

    // Log at appropriate level based on severity
    switch (event.severity) {
      case AuditSeverity.CRITICAL:
      case AuditSeverity.ERROR:
        logger.error(logEntry);
        break;
      case AuditSeverity.WARNING:
        logger.warn(logEntry);
        break;
      case AuditSeverity.INFO:
      default:
        logger.info(logEntry);
        break;
    }
  }

  /**
   * Log challenge issued event
   */
  logChallengeIssued(params: {
    walletAddress: string;
    challengeId: string;
    expiresAt: Date;
    requestId?: string;
    ipAddress?: string;
    userAgent?: string;
  }): void {
    this.log({
      eventType: AuditEventType.CHALLENGE_ISSUED,
      severity: AuditSeverity.INFO,
      message: 'Authentication challenge issued',
      outcome: 'success',
      actor: {
        type: 'anonymous',
        walletAddress: params.walletAddress,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      context: {
        requestId: params.requestId,
        endpoint: '/api/auth/challenge',
        method: 'POST',
        timestamp: new Date().toISOString(),
      },
      resource: {
        type: 'challenge',
        id: params.challengeId,
        walletAddress: params.walletAddress,
      },
      metadata: {
        expiresAt: params.expiresAt.toISOString(),
        ttlSeconds: Math.floor((params.expiresAt.getTime() - Date.now()) / 1000),
      },
    });
  }

  /**
   * Log challenge verified successfully
   */
  logChallengeVerified(params: {
    walletAddress: string;
    userId: string;
    challengeId: string;
    isNewUser: boolean;
    requestId?: string;
    ipAddress?: string;
    userAgent?: string;
  }): void {
    this.log({
      eventType: AuditEventType.CHALLENGE_VERIFIED,
      severity: AuditSeverity.INFO,
      message: 'Authentication challenge verified successfully',
      outcome: 'success',
      actor: {
        type: 'user',
        walletAddress: params.walletAddress,
        userId: params.userId,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      context: {
        requestId: params.requestId,
        endpoint: '/api/auth/connect',
        method: 'POST',
        timestamp: new Date().toISOString(),
      },
      resource: {
        type: 'challenge',
        id: params.challengeId,
        walletAddress: params.walletAddress,
      },
      metadata: {
        isNewUser: params.isNewUser,
        authMethod: 'wallet_signature',
      },
    });
  }

  /**
   * Log challenge verification failed
   */
  logChallengeFailed(params: {
    walletAddress: string;
    challengeId?: string;
    reason: 'invalid_signature' | 'challenge_not_found' | 'challenge_expired' | 'challenge_used' | 'wallet_mismatch';
    requestId?: string;
    ipAddress?: string;
    userAgent?: string;
  }): void {
    this.log({
      eventType: AuditEventType.CHALLENGE_FAILED,
      severity: AuditSeverity.WARNING,
      message: `Authentication challenge verification failed: ${params.reason}`,
      outcome: 'failure',
      actor: {
        type: 'anonymous',
        walletAddress: params.walletAddress,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      context: {
        requestId: params.requestId,
        endpoint: '/api/auth/connect',
        method: 'POST',
        timestamp: new Date().toISOString(),
      },
      resource: params.challengeId ? {
        type: 'challenge',
        id: params.challengeId,
        walletAddress: params.walletAddress,
      } : undefined,
      metadata: {
        failureReason: params.reason,
      },
    });
  }

  /**
   * Log challenge expired
   */
  logChallengeExpired(params: {
    walletAddress: string;
    challengeId: string;
    expiresAt: Date;
    requestId?: string;
    ipAddress?: string;
  }): void {
    this.log({
      eventType: AuditEventType.CHALLENGE_EXPIRED,
      severity: AuditSeverity.INFO,
      message: 'Authentication challenge expired',
      outcome: 'failure',
      actor: {
        type: 'anonymous',
        walletAddress: params.walletAddress,
        ipAddress: params.ipAddress,
      },
      context: {
        requestId: params.requestId,
        endpoint: '/api/auth/connect',
        method: 'POST',
        timestamp: new Date().toISOString(),
      },
      resource: {
        type: 'challenge',
        id: params.challengeId,
        walletAddress: params.walletAddress,
      },
      metadata: {
        expiresAt: params.expiresAt.toISOString(),
        expiredSecondsAgo: Math.floor((Date.now() - params.expiresAt.getTime()) / 1000),
      },
    });
  }

  /**
   * Log challenge invalidated (used or deleted)
   */
  logChallengeInvalidated(params: {
    walletAddress: string;
    challengeId: string;
    reason: 'used' | 'replaced' | 'cleanup';
    requestId?: string;
  }): void {
    this.log({
      eventType: AuditEventType.CHALLENGE_INVALIDATED,
      severity: AuditSeverity.INFO,
      message: `Authentication challenge invalidated: ${params.reason}`,
      outcome: 'success',
      actor: {
        type: 'system',
        walletAddress: params.walletAddress,
      },
      context: {
        requestId: params.requestId,
        timestamp: new Date().toISOString(),
      },
      resource: {
        type: 'challenge',
        id: params.challengeId,
        walletAddress: params.walletAddress,
      },
      metadata: {
        invalidationReason: params.reason,
      },
    });
  }

  /**
   * Log challenge reuse attempt
   */
  logChallengeReused(params: {
    walletAddress: string;
    challengeId: string;
    usedAt: Date;
    requestId?: string;
    ipAddress?: string;
    userAgent?: string;
  }): void {
    this.log({
      eventType: AuditEventType.CHALLENGE_REUSED,
      severity: AuditSeverity.WARNING,
      message: 'Attempt to reuse already-consumed authentication challenge',
      outcome: 'failure',
      actor: {
        type: 'anonymous',
        walletAddress: params.walletAddress,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      context: {
        requestId: params.requestId,
        endpoint: '/api/auth/connect',
        method: 'POST',
        timestamp: new Date().toISOString(),
      },
      resource: {
        type: 'challenge',
        id: params.challengeId,
        walletAddress: params.walletAddress,
      },
      metadata: {
        originalUsedAt: params.usedAt.toISOString(),
        secondsSinceUsed: Math.floor((Date.now() - params.usedAt.getTime()) / 1000),
      },
    });
  }

  /**
   * Log invalid signature
   */
  logInvalidSignature(params: {
    walletAddress: string;
    challengeId: string;
    requestId?: string;
    ipAddress?: string;
    userAgent?: string;
  }): void {
    this.log({
      eventType: AuditEventType.SIGNATURE_INVALID,
      severity: AuditSeverity.WARNING,
      message: 'Invalid signature provided for authentication challenge',
      outcome: 'failure',
      actor: {
        type: 'anonymous',
        walletAddress: params.walletAddress,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      context: {
        requestId: params.requestId,
        endpoint: '/api/auth/connect',
        method: 'POST',
        timestamp: new Date().toISOString(),
      },
      resource: {
        type: 'challenge',
        id: params.challengeId,
        walletAddress: params.walletAddress,
      },
      metadata: {
        verificationMethod: 'stellar_sdk',
      },
    });
  }

  /**
   * Log successful authentication
   */
  logAuthSuccess(params: {
    walletAddress: string;
    userId: string;
    isNewUser: boolean;
    requestId?: string;
    ipAddress?: string;
    userAgent?: string;
  }): void {
    this.log({
      eventType: AuditEventType.AUTH_SUCCESS,
      severity: AuditSeverity.INFO,
      message: 'User authenticated successfully',
      outcome: 'success',
      actor: {
        type: 'user',
        walletAddress: params.walletAddress,
        userId: params.userId,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      context: {
        requestId: params.requestId,
        endpoint: '/api/auth/connect',
        method: 'POST',
        timestamp: new Date().toISOString(),
      },
      resource: {
        type: 'user',
        id: params.userId,
        walletAddress: params.walletAddress,
      },
      metadata: {
        isNewUser: params.isNewUser,
        authMethod: 'wallet_signature',
      },
    });
  }

  /**
   * Log new user creation
   */
  logUserCreated(params: {
    walletAddress: string;
    userId: string;
    requestId?: string;
    ipAddress?: string;
  }): void {
    this.log({
      eventType: AuditEventType.USER_CREATED,
      severity: AuditSeverity.INFO,
      message: 'New user account created',
      outcome: 'success',
      actor: {
        type: 'system',
      },
      context: {
        requestId: params.requestId,
        endpoint: '/api/auth/connect',
        method: 'POST',
        timestamp: new Date().toISOString(),
      },
      resource: {
        type: 'user',
        id: params.userId,
        walletAddress: params.walletAddress,
      },
      metadata: {
        registrationMethod: 'wallet_authentication',
        ipAddress: params.ipAddress,
      },
    });
  }

  /**
   * Log user login
   */
  logUserLogin(params: {
    walletAddress: string;
    userId: string;
    streak: number;
    bonusAwarded: number;
    requestId?: string;
    ipAddress?: string;
  }): void {
    this.log({
      eventType: AuditEventType.USER_LOGIN,
      severity: AuditSeverity.INFO,
      message: 'User logged in',
      outcome: 'success',
      actor: {
        type: 'user',
        walletAddress: params.walletAddress,
        userId: params.userId,
        ipAddress: params.ipAddress,
      },
      context: {
        requestId: params.requestId,
        endpoint: '/api/auth/connect',
        method: 'POST',
        timestamp: new Date().toISOString(),
      },
      resource: {
        type: 'user',
        id: params.userId,
        walletAddress: params.walletAddress,
      },
      metadata: {
        streak: params.streak,
        bonusAwarded: params.bonusAwarded,
      },
    });
  }

  /**
   * Sanitize actor information to remove sensitive data
   */
  private sanitizeActor(actor: AuditActor): AuditActor {
    return {
      ...actor,
      // Truncate user agent to prevent log injection
      userAgent: actor.userAgent ? actor.userAgent.substring(0, 200) : undefined,
    };
  }
}

// Export singleton instance
export const auditLogger = new AuditLogger();

// Export for testing
export default auditLogger;
