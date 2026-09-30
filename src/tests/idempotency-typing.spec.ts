import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import {
   acquireIdempotencyLock,
   checkIdempotency,
   IdempotencyCheckResult,
   IDEMPOTENCY_STORE_UNAVAILABLE,
   isValidIdempotencyKey,
   releaseIdempotencyLock,
   resetInMemoryIdempotencyStore,
   storeIdempotencyResult,
} from '../utils/idempotency.util';

// A jest.fn-based Prisma mock lets the DB-path suite below inspect what
// crosses the storage boundary and feed back arbitrary JsonValue rows
// (including malformed ones) without a live database. The memory-mode suite
// never touches prisma (it uses the in-memory idempotency store).
jest.mock('../lib/prisma', () => ({
   prisma: {
      idempotencyKey: {
         create: jest.fn(),
         delete: jest.fn(),
         deleteMany: jest.fn(),
         findUnique: jest.fn(),
         upsert: jest.fn(),
      },
   },
}));

interface TestRequestBody {
   roundId: string;
   amount: number;
   side: 'UP' | 'DOWN';
   nested: {
      account: string;
      tags: string[];
   };
}

interface TestResponseBody {
   success: boolean;
   betId: string;
   payoutRatio: number;
}

describe('Idempotency Utility - Type Safety & Generics', () => {
   const originalEnv = process.env;

   beforeEach(() => {
      process.env = { ...originalEnv, DATA_STORE: 'memory' };
      resetInMemoryIdempotencyStore();
   });

   afterEach(() => {
      process.env = originalEnv;
      resetInMemoryIdempotencyStore();
   });

   it('correctly types request and cached response payloads without any', async () => {
      const userId = 'usr-001';
      const endpoint = '/api/bets/submit';
      const key = 'idem-key-typed-12345';

      const requestPayload: TestRequestBody = {
         roundId: 'rnd-88',
         amount: 250,
         side: 'UP',
         nested: {
            account: 'GBZX...9QRA',
            tags: ['crypto', 'stellar'],
         },
      };

      const responsePayload: TestResponseBody = {
         success: true,
         betId: 'bet-999',
         payoutRatio: 1.95,
      };

      // 1. Initial check (not idempotent yet)
      const check1: IdempotencyCheckResult<TestResponseBody> =
         await checkIdempotency<TestRequestBody, TestResponseBody>(
            userId,
            endpoint,
            key,
            requestPayload,
         );
      expect(check1.isIdempotent).toBe(false);
      expect(check1.cachedResponse).toBeUndefined();

      // 2. Store response
      await storeIdempotencyResult<TestRequestBody, TestResponseBody>(
         userId,
         endpoint,
         key,
         requestPayload,
         200,
         responsePayload,
      );

      // 3. Cache hit check (typed cachedResponse.body)
      const check2: IdempotencyCheckResult<TestResponseBody> =
         await checkIdempotency<TestRequestBody, TestResponseBody>(
            userId,
            endpoint,
            key,
            requestPayload,
         );

      expect(check2.isIdempotent).toBe(true);
      expect(check2.cachedResponse).toBeDefined();
      expect(check2.cachedResponse?.status).toBe(200);

      const cachedBody: TestResponseBody | undefined = check2.cachedResponse?.body;
      expect(cachedBody?.success).toBe(true);
      expect(cachedBody?.betId).toBe('bet-999');
      expect(cachedBody?.payoutRatio).toBe(1.95);
   });

   it('acquires and releases in-memory typed locks safely', async () => {
      const userId = 'usr-002';
      const endpoint = '/api/predictions/submit';
      const key = 'idem-lock-key-54321';

      const reqBody: TestRequestBody = {
         roundId: 'rnd-101',
         amount: 500,
         side: 'DOWN',
         nested: {
            account: 'GABC...1234',
            tags: ['prediction'],
         },
      };

      const lockRes = await acquireIdempotencyLock<TestRequestBody, TestResponseBody>(
         userId,
         endpoint,
         key,
         reqBody,
      );

      expect(lockRes.isIdempotent).toBe(false);
      expect(lockRes.lockAcquired).toBe(true);

      await releaseIdempotencyLock(userId, endpoint, key);

      const secondLock = await acquireIdempotencyLock<TestRequestBody, TestResponseBody>(
         userId,
         endpoint,
         key,
         reqBody,
      );
      expect(secondLock.isIdempotent).toBe(false);
      expect(secondLock.lockAcquired).toBe(true);
   });

   it('validates idempotency key format correctly', () => {
      expect(isValidIdempotencyKey('valid-uuid-key-12345')).toBe(true);
      expect(isValidIdempotencyKey('short')).toBe(false);
      expect(isValidIdempotencyKey('')).toBe(false);
   });
});

describe('Idempotency Utility - Prisma storage boundary', () => {
   const originalEnv = process.env;

   /** Structural view of the jest.fn-backed Prisma model delegates. */
   type ModelMock = {
      mock: { calls: unknown[][] };
      mockResolvedValueOnce(value: unknown): void;
      mockRejectedValueOnce(reason: unknown): void;
   };

   const idempotencyKeyModel = (prisma as unknown as {
      idempotencyKey: Record<string, ModelMock>;
   }).idempotencyKey;

   /**
    * Captures the request hash the utility computes for `body` by letting
    * acquireIdempotencyLock persist its pending lock (status 102) against the
    * mocked Prisma model and reading the stored hash back. Keeps the black-box
    * test aligned with the util's private hashing without exposing new API
    * surface for tests.
    */
   async function captureRequestHash(body: unknown): Promise<string> {
      const probe = await acquireIdempotencyLock(
         'usr-hash-probe',
         '/hash-probe',
         'hash-probe-key',
         body,
      );
      expect(probe.lockAcquired).toBe(true);
      const calls = idempotencyKeyModel.create.mock.calls;
      const createArg = calls[calls.length - 1]?.[0] as
         | { data: { requestHash: string } }
         | undefined;
      await releaseIdempotencyLock('usr-hash-probe', '/hash-probe', 'hash-probe-key');
      if (!createArg) throw new Error('hash probe did not persist a lock row');
      return createArg.data.requestHash;
   }

   interface ClaimBody {
      address: string;
   }

   interface ClaimResponse {
      success: boolean;
      amount: number;
   }

   beforeEach(() => {
      process.env = { ...originalEnv };
      process.env.DATA_STORE = 'postgres';
      process.env.BET_STUB_MODE = 'false';
      jest.clearAllMocks();
   });

   afterEach(() => {
      process.env = originalEnv;
   });

   it('persists the response body as a JSON round-trip of the stored value', async () => {
      const responseBody: ClaimResponse = { success: true, amount: 42.5 };

      await storeIdempotencyResult<ClaimBody, ClaimResponse>(
         'usr-boundary',
         '/api/bets/claim',
         'boundary-roundtrip-0001',
         { address: 'GBZX...BOUNDARY' },
         200,
         responseBody,
      );

      expect(idempotencyKeyModel.upsert.mock.calls.length).toBe(1);
      const upsertArg = idempotencyKeyModel.upsert.mock.calls[0][0] as {
         create: { responseBody: Prisma.InputJsonValue };
         update: { responseBody: Prisma.InputJsonValue };
      };
      expect(upsertArg.create.responseBody).toEqual(responseBody);
      expect(upsertArg.update.responseBody).toEqual(responseBody);
   });

   it('replays the FIRST stored response through the DB path (checkIdempotency)', async () => {
      const firstResponse = { success: true, amount: 100 } as const;
      const requestHash = await captureRequestHash({ address: 'GBZX...REPLAY' });
      idempotencyKeyModel.findUnique.mockResolvedValueOnce({
         id: 'row-1',
         requestHash,
         responseStatus: 200,
         responseBody: firstResponse satisfies Prisma.JsonValue,
         expiresAt: new Date(Date.now() + 60_000),
      });

      const result = await checkIdempotency<ClaimBody, ClaimResponse>(
         'usr-replay',
         '/api/bets/claim',
         'db-replay-first-0001',
         { address: 'GBZX...REPLAY' },
      );

      expect(result.isIdempotent).toBe(true);
      expect(result.cachedResponse).toEqual({ status: 200, body: firstResponse });
      expect(result.error).toBeUndefined();
   });

   it('replays the FIRST stored response through the DB path (acquireIdempotencyLock)', async () => {
      const firstResponse = { success: true, amount: 7 } as const;
      const requestHash = await captureRequestHash({ address: 'GBZX...REPLAY2' });
      idempotencyKeyModel.findUnique.mockResolvedValueOnce({
         id: 'row-2',
         requestHash,
         responseStatus: 200,
         responseBody: firstResponse satisfies Prisma.JsonValue,
         expiresAt: new Date(Date.now() + 60_000),
      });

      const result = await acquireIdempotencyLock<ClaimBody, ClaimResponse>(
         'usr-replay-2',
         '/api/bets/claim',
         'db-replay-first-0002',
         { address: 'GBZX...REPLAY2' },
      );

      expect(result.isIdempotent).toBe(true);
      expect(result.cachedResponse).toEqual({ status: 200, body: firstResponse });
   });

   it('rejects key reuse with a different request body (DB path)', async () => {
      const requestHash = await captureRequestHash({ address: 'GBZX...ORIGINAL' });
      idempotencyKeyModel.findUnique.mockResolvedValueOnce({
         id: 'row-3',
         requestHash,
         responseStatus: 200,
         responseBody: { success: true, amount: 1 },
         expiresAt: new Date(Date.now() + 60_000),
      });

      const result = await acquireIdempotencyLock<ClaimBody, ClaimResponse>(
         'usr-conflict',
         '/api/bets/claim',
         'db-conflict-0001',
         { address: 'GBZX...DIFFERENT' },
      );

      expect(result.isIdempotent).toBe(true);
      expect(result.cachedResponse).toBeUndefined();
      expect(result.error).toBe('Idempotency key reused with different request body');
   });

   it('treats an expired stored record as a fresh request', async () => {
      const requestHash = await captureRequestHash({ address: 'GBZX...EXPIRED' });
      idempotencyKeyModel.findUnique.mockResolvedValueOnce({
         id: 'row-4',
         requestHash,
         responseStatus: 200,
         responseBody: { success: true, amount: 5 },
         expiresAt: new Date(Date.now() - 60_000),
      });

      const result = await checkIdempotency<ClaimBody, ClaimResponse>(
         'usr-expired',
         '/api/bets/claim',
         'db-expired-0001',
         { address: 'GBZX...EXPIRED' },
      );

      expect(result.isIdempotent).toBe(false);
      expect(result.cachedResponse).toBeUndefined();
      expect(idempotencyKeyModel.delete).toHaveBeenCalledWith({ where: { id: 'row-4' } });
   });

   it('surfaces IDEMPOTENCY_STORE_UNAVAILABLE when the store read fails', async () => {
      idempotencyKeyModel.findUnique.mockRejectedValueOnce(new Error('database down'));

      const result = await checkIdempotency<ClaimBody, ClaimResponse>(
         'usr-outage',
         '/api/bets/claim',
         'db-outage-0001',
         { address: 'GBZX...OUTAGE' },
      );

      expect(result.isIdempotent).toBe(true);
      expect(result.error).toBe(IDEMPOTENCY_STORE_UNAVAILABLE);
   });
});
