/**
 * Unit tests for the central log redaction helpers (shared Render logs must
 * never contain full wallet addresses, Authorization headers or
 * env-like secrets such as JWT_SECRET).
 *
 * Helpers are imported from ../utils/logger — the canonical entry point —
 * to guarantee the public API surface exists there.
 *
 * Run:  npx jest src/tests/logger-redaction.spec.ts
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import winston from 'winston';
import logger, { redact, redactField, redactWallet, REDACTED } from '../utils/logger';
import { redactLogInfo } from '../utils/log-redaction';

/** A valid-shaped Stellar public address: `G` + 55 base32 chars = 56 total. */
const FULL_ADDRESS = `G${'A'.repeat(55)}`;
const TRUNCATED_ADDRESS = `${FULL_ADDRESS.slice(0, 4)}…${FULL_ADDRESS.slice(-4)}`;

/** JWT-shaped value (header.payload.signature). */
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP';
const AUTH_HEADER = `Bearer ${JWT}`;

const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

afterEach(() => {
  if (ORIGINAL_JWT_SECRET === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  }
});

describe('redactWallet', () => {
  it('truncates a Stellar address to first/last 4 characters', () => {
    const redacted = redactWallet(FULL_ADDRESS);
    expect(redacted).toBe(TRUNCATED_ADDRESS);
    expect(redacted).toMatch(/^G[A-Z2-7]{3}…[A-Z2-7]{4}$/);
    expect(redacted).not.toContain(FULL_ADDRESS);
  });

  it('fully masks values that are too short to truncate', () => {
    expect(redactWallet('GSHORT')).toBe(REDACTED);
    expect(redactWallet('12345678')).toBe(REDACTED);
  });

  it('masks non-string values instead of stringifying them', () => {
    expect(redactWallet(undefined)).toBe(REDACTED);
    expect(redactWallet(null)).toBe(REDACTED);
    expect(redactWallet(123456789)).toBe(REDACTED);
  });
});

describe('redact', () => {
  it('never returns an Authorization header value', () => {
    const out = redact({ authorization: AUTH_HEADER }) as Record<string, unknown>;
    expect(out.authorization).toBe('Bearer [REDACTED]');
    expect(JSON.stringify(out)).not.toContain(JWT);
    expect(JSON.stringify(out)).not.toContain('eyJhbGci');
  });

  it('masks non-bearer Authorization values by key', () => {
    const out = redact({ authorization: 'InvalidFormat token' }) as Record<string, unknown>;
    expect(out.authorization).toBe(REDACTED);
    expect(JSON.stringify(out)).not.toContain('InvalidFormat');
  });

  it('masks cookies, API keys and secret-like keys by key name', () => {
    const out = redact({
      cookie: 'session=abc',
      'x-api-key': 'sk_live_123',
      jwtSecret: 'super-secret',
      accessToken: 'tok_123',
      passwordHash: 'pbkdf2:abc',
    }) as Record<string, unknown>;

    expect(out.cookie).toBe(REDACTED);
    expect(out['x-api-key']).toBe(REDACTED);
    expect(out.jwtSecret).toBe(REDACTED);
    expect(out.accessToken).toBe(REDACTED);
    expect(out.passwordHash).toBe(REDACTED);
  });

  it('masks bearer credentials found in plain string values', () => {
    const out = redact({ note: `forwarded ${AUTH_HEADER} upstream` });
    expect(out).toEqual({ note: 'Bearer [REDACTED]' });
  });

  it('truncates wallet values under address/wallet keys', () => {
    const out = redact({
      address: FULL_ADDRESS,
      walletAddress: FULL_ADDRESS,
      userAddress: FULL_ADDRESS,
      publicKey: FULL_ADDRESS,
      nested: { walletAddress: FULL_ADDRESS },
    }) as Record<string, any>;

    expect(out.address).toBe(TRUNCATED_ADDRESS);
    expect(out.walletAddress).toBe(TRUNCATED_ADDRESS);
    expect(out.userAddress).toBe(TRUNCATED_ADDRESS);
    expect(out.publicKey).toBe(TRUNCATED_ADDRESS);
    expect(out.nested.walletAddress).toBe(TRUNCATED_ADDRESS);
    expect(JSON.stringify(out)).not.toContain(FULL_ADDRESS);
  });

  it('scrubs wallet addresses embedded anywhere in message strings', () => {
    const out = redact(`bet accepted for ${FULL_ADDRESS} on round r-1`);
    expect(out).toBe(`bet accepted for ${TRUNCATED_ADDRESS} on round r-1`);
  });

  it('scrubs JWT-shaped values embedded in message strings', () => {
    const out = redact(`token was ${JWT}`);
    expect(out).toBe('token was [REDACTED]');
    expect(out).not.toContain('eyJhbGci');
  });

  it('never emits configured env secret values (JWT_SECRET)', () => {
    const secret = 'sup3r-s3cret-jwt-value-42';
    process.env.JWT_SECRET = secret;
    expect(redact(secret)).toBe(REDACTED);
    expect(redact({ note: `configured with ${secret} today` })).toEqual({
      note: 'configured with [REDACTED] today',
    });
  });

  it('leaves non-sensitive debugging fields untouched', () => {
    const input = {
      requestId: 'req-123',
      roundId: 'round-42',
      userId: 'user-1',
      side: 'UP',
      amount: 10,
      status: 200,
      active: true,
      note: null,
    };
    expect(redact(input)).toEqual(input);
  });

  it('recurses into arrays', () => {
    const out = redact({ items: [{ walletAddress: FULL_ADDRESS }, 'plain'] }) as Record<string, any>;
    expect(out.items[0].walletAddress).toBe(TRUNCATED_ADDRESS);
    expect(out.items[1]).toBe('plain');
  });

  it('is idempotent (redacting redacted data is a no-op)', () => {
    const input = {
      authorization: AUTH_HEADER,
      walletAddress: FULL_ADDRESS,
      message: `user ${FULL_ADDRESS}`,
    };
    const once = redact(input);
    expect(redact(once)).toEqual(once);
  });

  it('does not mutate the input object', () => {
    const input = { walletAddress: FULL_ADDRESS, headers: { authorization: AUTH_HEADER } };
    redact(input);
    expect(input.walletAddress).toBe(FULL_ADDRESS);
    expect(input.headers.authorization).toBe(AUTH_HEADER);
  });

  it('handles circular references without throwing', () => {
    const input: Record<string, unknown> = { walletAddress: FULL_ADDRESS };
    input.self = input;
    const out = redact(input) as Record<string, unknown>;
    expect(out.walletAddress).toBe(TRUNCATED_ADDRESS);
    expect(out.self).toBe('[Circular]');
  });
});

describe('redactField', () => {
  it('redacts headers by header name', () => {
    expect(redactField('authorization', AUTH_HEADER)).toBe('Bearer [REDACTED]');
    expect(redactField('authorization', 'InvalidFormat')).toBe(REDACTED);
    expect(redactField('cookie', 'a=b')).toBe(REDACTED);
    expect(redactField('x-api-key', 'sk_live_123')).toBe(REDACTED);
    expect(redactField('content-type', 'application/json')).toBe('application/json');
    expect(redactField('walletAddress', FULL_ADDRESS)).toBe(TRUNCATED_ADDRESS);
  });
});

describe('redactLogInfo (winston format adapter)', () => {
  it('keeps level/message while redacting metadata', () => {
    const out = redactLogInfo({
      level: 'info',
      message: 'http request',
      headers: { authorization: AUTH_HEADER },
      body: { address: FULL_ADDRESS, amount: 5 },
    });

    expect(out.level).toBe('info');
    expect(out.message).toBe('http request');
    expect((out.headers as any).authorization).toBe('Bearer [REDACTED]');
    expect((out.body as any).address).toBe(TRUNCATED_ADDRESS);
    expect((out.body as any).amount).toBe(5);
    expect(JSON.stringify(out)).not.toContain(JWT);
    expect(JSON.stringify(out)).not.toContain(FULL_ADDRESS);
  });
});

describe('winston logger redaction format (end-to-end)', () => {
  class CaptureTransport extends winston.Transport {
    entries: Array<Record<string, any>> = [];

    log(info: Record<string, any>, callback: () => void): void {
      this.entries.push(info);
      callback();
    }
  }

  it('scrubs raw secrets and wallets from emitted log entries', () => {
    const transport = new CaptureTransport({ name: 'capture' });
    logger.add(transport);

    try {
      logger.info('http request', {
        method: 'POST',
        path: '/api/bets/up-down',
        headers: { authorization: AUTH_HEADER, 'x-api-key': 'sk_live_123' },
        body: { address: FULL_ADDRESS, amount: 5 },
        note: `wallet ${FULL_ADDRESS} wagered`,
      });

      expect(transport.entries).toHaveLength(1);
      const info = transport.entries[0];
      const serialized =
        typeof info[Symbol.for('message')] === 'string'
          ? info[Symbol.for('message')]
          : JSON.stringify(info);

      expect(serialized).not.toContain(JWT);
      expect(serialized).not.toContain('eyJhbGci');
      expect(serialized).not.toContain('sk_live_123');
      expect(serialized).not.toContain(FULL_ADDRESS);
      expect(String(info.headers.authorization)).toMatch(/REDACTED/);
      expect(info.headers['x-api-key']).toBe(REDACTED);
      expect(info.body.address).toBe(TRUNCATED_ADDRESS);
      expect(info.body.amount).toBe(5);
      expect(String(info.note)).toContain(TRUNCATED_ADDRESS);
      expect(info.method).toBe('POST');
    } finally {
      logger.remove(transport);
    }
  });
});
