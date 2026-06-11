/**
 * Tests for the socket token refresh & reconnect contract.
 * Verifies AUTH_TOKEN_EXPIRED error emission, checkExpiredTokenSockets, and
 * verifyTokenDetailed differentiation of expired vs. invalid tokens.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  checkExpiredTokenSockets,
  connectionRegistry,
  AUTH_TOKEN_EXPIRED,
  AUTH_TOKEN_INVALID,
} from '../socket';
import { verifyTokenDetailed } from '../utils/jwt.util';
import jwt from 'jsonwebtoken';

// ─── verifyTokenDetailed ────────────────────────────────────────────────────

const SECRET = 'test-secret-long-enough-for-tests';

function makeToken(expiresIn: string | number): string {
  return jwt.sign({ userId: 'u1', walletAddress: 'GABCD', role: 'USER' }, SECRET, {
    expiresIn: expiresIn as any,
  });
}

describe('verifyTokenDetailed', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
  });

  it('returns valid=true for a live token', () => {
    const token = makeToken('1h');
    const result = verifyTokenDetailed(token);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.userId).toBe('u1');
    }
  });

  it('returns valid=false, expired=true for an expired token', () => {
    const token = makeToken(-1); // already expired
    const result = verifyTokenDetailed(token);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.expired).toBe(true);
    }
  });

  it('returns valid=false, expired=false for a structurally-invalid token', () => {
    const result = verifyTokenDetailed('not.a.jwt');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.expired).toBe(false);
    }
  });
});

// ─── checkExpiredTokenSockets ───────────────────────────────────────────────

function buildMockIo(sockets: Record<string, { emit: jest.Mock; disconnect: jest.Mock }>) {
  return {
    sockets: {
      sockets: new Map(Object.entries(sockets)),
    },
  } as any;
}

describe('checkExpiredTokenSockets', () => {
  beforeEach(() => {
    connectionRegistry.clear();
  });

  it('does not notify sockets with no tokenExpiresAt', () => {
    connectionRegistry.set('s1', {
      userId: 'u1',
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    const mockEmit = jest.fn();
    const mockDisconnect = jest.fn();
    const io = buildMockIo({ s1: { emit: mockEmit, disconnect: mockDisconnect } });

    const notified = checkExpiredTokenSockets(io, Date.now());
    expect(notified).toBe(0);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('does not notify sockets whose token has not yet expired', () => {
    connectionRegistry.set('s1', {
      userId: 'u1',
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      tokenExpiresAt: Date.now() + 60_000,
    });
    const mockEmit = jest.fn();
    const mockDisconnect = jest.fn();
    const io = buildMockIo({ s1: { emit: mockEmit, disconnect: mockDisconnect } });

    const notified = checkExpiredTokenSockets(io, Date.now());
    expect(notified).toBe(0);
  });

  it('emits auth:error and disconnects when token is expired', () => {
    connectionRegistry.set('s1', {
      userId: 'u1',
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      tokenExpiresAt: Date.now() - 1,
    });
    const mockEmit = jest.fn();
    const mockDisconnect = jest.fn();
    const io = buildMockIo({ s1: { emit: mockEmit, disconnect: mockDisconnect } });

    const notified = checkExpiredTokenSockets(io, Date.now());
    expect(notified).toBe(1);
    expect(mockEmit).toHaveBeenCalledWith('auth:error', expect.objectContaining({
      code: AUTH_TOKEN_EXPIRED,
    }));
    expect(mockDisconnect).toHaveBeenCalledWith(false);
  });

  it('cleans up registry entry when socket is already gone', () => {
    connectionRegistry.set('gone', {
      userId: 'u2',
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      tokenExpiresAt: Date.now() - 1,
    });
    const io = buildMockIo({}); // no sockets map entry for 'gone'

    const notified = checkExpiredTokenSockets(io, Date.now());
    expect(notified).toBe(1);
    expect(connectionRegistry.has('gone')).toBe(false);
  });
});

// ─── constant exports ───────────────────────────────────────────────────────

describe('socket error code constants', () => {
  it('exports AUTH_TOKEN_EXPIRED as a string', () => {
    expect(typeof AUTH_TOKEN_EXPIRED).toBe('string');
    expect(AUTH_TOKEN_EXPIRED).toBe('AUTH_TOKEN_EXPIRED');
  });

  it('exports AUTH_TOKEN_INVALID as a string', () => {
    expect(typeof AUTH_TOKEN_INVALID).toBe('string');
    expect(AUTH_TOKEN_INVALID).toBe('AUTH_TOKEN_INVALID');
  });
});
