import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
   acquireIdempotencyLock,
   checkIdempotency,
   IdempotencyCheckResult,
   isValidIdempotencyKey,
   releaseIdempotencyLock,
   resetInMemoryIdempotencyStore,
   storeIdempotencyResult,
} from '../utils/idempotency.util';

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
