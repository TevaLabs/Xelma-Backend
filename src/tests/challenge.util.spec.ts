import { describe, it, expect } from '@jest/globals';
import {
  generateChallenge,
  generateLegacyChallenge,
  buildChallengeMessage,
  getChallengeExpiry,
  isChallengeExpired,
  getChallengeExpirySeconds,
  isLegacyChallenge,
  parseChallenge,
  isValidChallengeDomain,
  isChallengeWalletBindingValid,
  getAuthDomain,
  getHomeDomain,
} from '../utils/challenge.util';

describe('challenge.util', () => {
  describe('generateChallenge (SEP-10-style)', () => {
    it('produces a SEP-10-style human-readable challenge with Domain and Home Domain', () => {
      const challenge = generateChallenge();
      expect(challenge).toContain('Xelma Authentication');
      expect(challenge).toContain(`Domain: ${getAuthDomain()}`);
      expect(challenge).toContain(`Home Domain: ${getHomeDomain()}`);
      expect(challenge).toContain('Nonce:');
      expect(challenge).toContain('Issued At:');
      expect(challenge).toContain('Version: 1');
      // legacy regex should NOT match new format
      expect(isLegacyChallenge(challenge)).toBe(false);
    });

    it('binds wallet address into challenge when provided', () => {
      const wallet = 'GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX';
      const challenge = generateChallenge(wallet);
      expect(challenge).toContain(`Address: ${wallet}`);
      const parsed = parseChallenge(challenge);
      expect(parsed?.walletAddress).toBe(wallet);
      expect(parsed?.isLegacy).toBe(false);
    });

    it('produces a unique value on every call', () => {
      const a = generateChallenge();
      const b = generateChallenge();
      expect(a).not.toBe(b);
    });

    it('uses configured AUTH_DOMAIN / HOME_DOMAIN when set', () => {
      const origAuth = process.env.AUTH_DOMAIN;
      const origHome = process.env.HOME_DOMAIN;
      process.env.AUTH_DOMAIN = 'auth.example.com';
      process.env.HOME_DOMAIN = 'home.example.com';
      try {
        const c = generateChallenge();
        expect(c).toContain('Domain: auth.example.com');
        expect(c).toContain('Home Domain: home.example.com');
        expect(getAuthDomain()).toBe('auth.example.com');
        expect(getHomeDomain()).toBe('home.example.com');
      } finally {
        if (origAuth === undefined) delete process.env.AUTH_DOMAIN;
        else process.env.AUTH_DOMAIN = origAuth;
        if (origHome === undefined) delete process.env.HOME_DOMAIN;
        else process.env.HOME_DOMAIN = origHome;
      }
    });
  });

  describe('generateLegacyChallenge (backward compat)', () => {
    it('produces a challenge in the xelma_auth_<timestamp>_<random> format', () => {
      const challenge = generateLegacyChallenge();
      expect(challenge).toMatch(/^xelma_auth_\d+_[0-9a-f]{64}$/);
      expect(isLegacyChallenge(challenge)).toBe(true);
    });
  });

  describe('buildChallengeMessage', () => {
    it('round-trips through parseChallenge', () => {
      const msg = buildChallengeMessage({
        domain: 'xelma.io',
        homeDomain: 'xelma.io',
        nonce: 'ab'.repeat(32),
        timestamp: 1725148800000,
        issuedAt: new Date(1725148800000).toISOString(),
        walletAddress: 'GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX',
        version: 1,
      });
      const parsed = parseChallenge(msg)!;
      expect(parsed.domain).toBe('xelma.io');
      expect(parsed.homeDomain).toBe('xelma.io');
      expect(parsed.nonce).toBe('ab'.repeat(32));
      expect(parsed.timestamp).toBe(1725148800000);
      expect(parsed.walletAddress).toBe('GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX');
      expect(parsed.version).toBe(1);
      expect(parsed.isLegacy).toBe(false);
    });
  });

  describe('parseChallenge', () => {
    it('parses legacy challenge', () => {
      const legacy = 'xelma_auth_1725148800000_' + 'ab'.repeat(32);
      const parsed = parseChallenge(legacy)!;
      expect(parsed.isLegacy).toBe(true);
      expect(parsed.nonce).toBe('ab'.repeat(32));
      expect(parsed.timestamp).toBe(1725148800000);
      expect(parsed.domain).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(parseChallenge('')).toBeNull();
      expect(parseChallenge(null as any)).toBeNull();
    });
  });

  describe('isValidChallengeDomain', () => {
    it('passes for legacy challenges', () => {
      const legacy = generateLegacyChallenge();
      expect(isValidChallengeDomain(legacy)).toBe(true);
    });

    it('passes when domain matches expected', () => {
      const msg = generateChallenge();
      expect(isValidChallengeDomain(msg)).toBe(true);
    });

    it('fails when domain is tampered', () => {
      const msg = buildChallengeMessage({ domain: 'evil.com', homeDomain: 'evil.com', nonce: 'ab'.repeat(32) });
      expect(isValidChallengeDomain(msg)).toBe(false);
    });

    it('fails when challenge has no domain', () => {
      expect(isValidChallengeDomain('Xelma Authentication\nNonce: abc\n')).toBe(false);
    });
  });

  describe('isChallengeWalletBindingValid', () => {
    it('passes for legacy (no binding)', () => {
      const legacy = generateLegacyChallenge();
      expect(isChallengeWalletBindingValid(legacy, 'GBANY')).toBe(true);
    });

    it('passes when address matches', () => {
      const wallet = 'GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX';
      const msg = generateChallenge(wallet);
      expect(isChallengeWalletBindingValid(msg, wallet)).toBe(true);
    });

    it('fails when address mismatched', () => {
      const wallet = 'GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX';
      const other = 'GA3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX';
      const msg = generateChallenge(wallet);
      expect(isChallengeWalletBindingValid(msg, other)).toBe(false);
    });

    it('passes when new challenge has no embedded address', () => {
      const msg = buildChallengeMessage({ domain: getAuthDomain(), homeDomain: getHomeDomain(), nonce: 'ab'.repeat(32) });
      expect(isChallengeWalletBindingValid(msg, 'GBANY')).toBe(true);
    });
  });

  describe('getChallengeExpiry', () => {
    it('returns a Date roughly 5 minutes in the future', () => {
      const before = Date.now();
      const expiry = getChallengeExpiry();
      const after = Date.now();

      const deltaFromBefore = expiry.getTime() - before;
      const deltaFromAfter = expiry.getTime() - after;

      expect(deltaFromBefore).toBeGreaterThanOrEqual(5 * 60 * 1000 - 1000);
      expect(deltaFromAfter).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
    });
  });

  describe('isChallengeExpired', () => {
    it('is false for a future expiry', () => {
      expect(isChallengeExpired(new Date(Date.now() + 60_000))).toBe(false);
    });

    it('is true for a past expiry', () => {
      expect(isChallengeExpired(new Date(Date.now() - 60_000))).toBe(true);
    });
  });

  describe('getChallengeExpirySeconds', () => {
    it('matches the 5-minute expiry window in seconds', () => {
      expect(getChallengeExpirySeconds()).toBe(300);
    });
  });
});
