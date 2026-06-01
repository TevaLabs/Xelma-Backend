import {
   describe,
   it,
   expect,
   beforeEach,
   afterEach,
   jest,
} from '@jest/globals';
import {
   checkIdempotency,
   storeIdempotencyResult,
   cleanupExpiredIdempotencyKeys,
   isValidIdempotencyKey,
} from '../utils/idempotency.util';
import { prisma } from '../lib/prisma';

describe('Idempotency Utility', () => {
   const userId = 'test-user-123';
   const endpoint = '/api/predictions/submit';
   const idempotencyKey = 'test-key-uuid-1234-5678';
   const requestBody = { roundId: 'round-1', amount: 100, side: 'UP' };

   beforeEach(async () => {
      // Clean up any existing test data
      await prisma.idempotencyKey.deleteMany({
         where: { userId },
      });
   });

   afterEach(async () => {
      // Clean up after each test
      await prisma.idempotencyKey.deleteMany({
         where: { userId },
      });
   });

   describe('isValidIdempotencyKey', () => {
      it('should accept valid UUID format', () => {
         expect(
            isValidIdempotencyKey('550e8400-e29b-41d4-a716-446655440000')
         ).toBe(true);
      });

      it('should accept alphanumeric with hyphens', () => {
         expect(isValidIdempotencyKey('test-key-123')).toBe(true);
      });

      it('should accept alphanumeric with underscores', () => {
         expect(isValidIdempotencyKey('test_key_123')).toBe(true);
      });

      it('should reject empty string', () => {
         expect(isValidIdempotencyKey('')).toBe(false);
      });

      it('should reject too short key', () => {
         expect(isValidIdempotencyKey('short')).toBe(false);
      });

      it('should reject special characters', () => {
         expect(isValidIdempotencyKey('test@key#123')).toBe(false);
      });

      it('should reject null/undefined', () => {
         expect(isValidIdempotencyKey(null as any)).toBe(false);
         expect(isValidIdempotencyKey(undefined as any)).toBe(false);
      });
   });

   describe('checkIdempotency', () => {
      it('should return isIdempotent=false for new key', async () => {
         const result = await checkIdempotency(
            userId,
            endpoint,
            idempotencyKey,
            requestBody
         );

         expect(result.isIdempotent).toBe(false);
         expect(result.cachedResponse).toBeUndefined();
      });

      it('should return cached response for duplicate request', async () => {
         const responseBody = { success: true, prediction: { id: 'pred-1' } };

         // Store first request
         await storeIdempotencyResult(
            userId,
            endpoint,
            idempotencyKey,
            requestBody,
            200,
            responseBody
         );

         // Check second request with same key
         const result = await checkIdempotency(
            userId,
            endpoint,
            idempotencyKey,
            requestBody
         );

         expect(result.isIdempotent).toBe(true);
         expect(result.cachedResponse).toBeDefined();
         expect(result.cachedResponse?.status).toBe(200);
         expect(result.cachedResponse?.body).toEqual(responseBody);
      });

      it('should detect request body mutation', async () => {
         const responseBody = { success: true, prediction: { id: 'pred-1' } };

         // Store first request
         await storeIdempotencyResult(
            userId,
            endpoint,
            idempotencyKey,
            requestBody,
            200,
            responseBody
         );

         // Check with different request body
         const mutatedBody = { ...requestBody, amount: 200 };
         const result = await checkIdempotency(
            userId,
            endpoint,
            idempotencyKey,
            mutatedBody
         );

         expect(result.isIdempotent).toBe(true);
         expect(result.error).toBeDefined();
         expect(result.error).toContain('different request body');
      });

      it('should handle expired keys', async () => {
         const responseBody = { success: true, prediction: { id: 'pred-1' } };

         // Store with past expiration
         const expiresAt = new Date();
         expiresAt.setHours(expiresAt.getHours() - 1);

         await prisma.idempotencyKey.create({
            data: {
               userId,
               endpoint,
               idempotencyKey,
               requestHash: 'hash123',
               responseStatus: 200,
               responseBody,
               expiresAt,
            },
         });

         // Check should treat as new request
         const result = await checkIdempotency(
            userId,
            endpoint,
            idempotencyKey,
            requestBody
         );

         expect(result.isIdempotent).toBe(false);

         // Expired key should be deleted
         const remaining = await prisma.idempotencyKey.findUnique({
            where: {
               userId_endpoint_idempotencyKey: {
                  userId,
                  endpoint,
                  idempotencyKey,
               },
            },
         });

         expect(remaining).toBeNull();
      });

      it('should scope keys by userId', async () => {
         const responseBody = { success: true, prediction: { id: 'pred-1' } };
         const otherUserId = 'other-user-456';

         // Store for first user
         await storeIdempotencyResult(
            userId,
            endpoint,
            idempotencyKey,
            requestBody,
            200,
            responseBody
         );

         // Check for different user with same key
         const result = await checkIdempotency(
            otherUserId,
            endpoint,
            idempotencyKey,
            requestBody
         );

         expect(result.isIdempotent).toBe(false);
      });

      it('should scope keys by endpoint', async () => {
         const responseBody = { success: true, prediction: { id: 'pred-1' } };
         const otherEndpoint = '/api/predictions/batch-submit';

         // Store for first endpoint
         await storeIdempotencyResult(
            userId,
            endpoint,
            idempotencyKey,
            requestBody,
            200,
            responseBody
         );

         // Check for different endpoint with same key
         const result = await checkIdempotency(
            userId,
            otherEndpoint,
            idempotencyKey,
            requestBody
         );

         expect(result.isIdempotent).toBe(false);
      });
   });

   describe('storeIdempotencyResult', () => {
      it('should store new idempotency result', async () => {
         const responseBody = { success: true, prediction: { id: 'pred-1' } };

         await storeIdempotencyResult(
            userId,
            endpoint,
            idempotencyKey,
            requestBody,
            200,
            responseBody
         );

         const stored = await prisma.idempotencyKey.findUnique({
            where: {
               userId_endpoint_idempotencyKey: {
                  userId,
                  endpoint,
                  idempotencyKey,
               },
            },
         });

         expect(stored).toBeDefined();
         expect(stored?.responseStatus).toBe(200);
         expect(stored?.responseBody).toEqual(responseBody);
      });

      it('should update existing idempotency result', async () => {
         const responseBody1 = { success: true, prediction: { id: 'pred-1' } };
         const responseBody2 = { success: true, prediction: { id: 'pred-2' } };

         // Store first result
         await storeIdempotencyResult(
            userId,
            endpoint,
            idempotencyKey,
            requestBody,
            200,
            responseBody1
         );

         // Update with new result
         await storeIdempotencyResult(
            userId,
            endpoint,
            idempotencyKey,
            requestBody,
            200,
            responseBody2
         );

         const stored = await prisma.idempotencyKey.findUnique({
            where: {
               userId_endpoint_idempotencyKey: {
                  userId,
                  endpoint,
                  idempotencyKey,
               },
            },
         });

         expect(stored?.responseBody).toEqual(responseBody2);
      });

      it('should set expiration to 10 minutes by default', async () => {
         const responseBody = { success: true, prediction: { id: 'pred-1' } };
         const beforeStore = new Date();

         await storeIdempotencyResult(
            userId,
            endpoint,
            idempotencyKey,
            requestBody,
            200,
            responseBody
         );

         const stored = await prisma.idempotencyKey.findUnique({
            where: {
               userId_endpoint_idempotencyKey: {
                  userId,
                  endpoint,
                  idempotencyKey,
               },
            },
         });

         const afterStore = new Date();
         const expectedExpiry = new Date(beforeStore);
         expectedExpiry.setMinutes(expectedExpiry.getMinutes() + 10);

         expect(stored?.expiresAt.getTime()).toBeGreaterThanOrEqual(
            expectedExpiry.getTime() - 1000
         );
         expect(stored?.expiresAt.getTime()).toBeLessThanOrEqual(
            afterStore.getTime() + 10 * 60 * 1000 + 1000
         );
      });

      it('should respect custom ttlMinutes', async () => {
         const responseBody = { success: true, prediction: { id: 'pred-1' } };
         const beforeStore = new Date();

         await storeIdempotencyResult(
            userId,
            endpoint,
            idempotencyKey,
            requestBody,
            200,
            responseBody,
            { ttlMinutes: 15 }
         );

         const stored = await prisma.idempotencyKey.findUnique({
            where: {
               userId_endpoint_idempotencyKey: {
                  userId,
                  endpoint,
                  idempotencyKey,
               },
            },
         });

         const expectedExpiry = new Date(beforeStore);
         expectedExpiry.setMinutes(expectedExpiry.getMinutes() + 15);

         expect(stored?.expiresAt.getTime()).toBeGreaterThanOrEqual(
            expectedExpiry.getTime() - 1000
         );
      });

      it('keeps ttlHours backwards compatible', async () => {
         const beforeStore = new Date();

         await storeIdempotencyResult(
            userId,
            endpoint,
            idempotencyKey,
            requestBody,
            200,
            { success: true },
            { ttlHours: 1 }
         );

         const stored = await prisma.idempotencyKey.findUnique({
            where: {
               userId_endpoint_idempotencyKey: {
                  userId,
                  endpoint,
                  idempotencyKey,
               },
            },
         });

         const expectedExpiry = new Date(beforeStore);
         expectedExpiry.setHours(expectedExpiry.getHours() + 1);
         expect(stored?.expiresAt.getTime()).toBeGreaterThanOrEqual(
            expectedExpiry.getTime() - 1000
         );
      });
   });

   describe('cleanupExpiredIdempotencyKeys', () => {
      it('should delete expired keys', async () => {
         const responseBody = { success: true, prediction: { id: 'pred-1' } };

         // Create expired key
         const expiresAt = new Date();
         expiresAt.setHours(expiresAt.getHours() - 1);

         await prisma.idempotencyKey.create({
            data: {
               userId,
               endpoint,
               idempotencyKey: 'expired-key',
               requestHash: 'hash123',
               responseStatus: 200,
               responseBody,
               expiresAt,
            },
         });

         // Create valid key
         await storeIdempotencyResult(
            userId,
            endpoint,
            'valid-key',
            requestBody,
            200,
            responseBody
         );

         // Run cleanup
         const deleted = await cleanupExpiredIdempotencyKeys();

         expect(deleted).toBe(1);

         // Verify expired key is gone
         const expiredKey = await prisma.idempotencyKey.findUnique({
            where: {
               userId_endpoint_idempotencyKey: {
                  userId,
                  endpoint,
                  idempotencyKey: 'expired-key',
               },
            },
         });

         expect(expiredKey).toBeNull();

         // Verify valid key still exists
         const validKey = await prisma.idempotencyKey.findUnique({
            where: {
               userId_endpoint_idempotencyKey: {
                  userId,
                  endpoint,
                  idempotencyKey: 'valid-key',
               },
            },
         });

         expect(validKey).toBeDefined();
      });

      it('should handle cleanup with no expired keys', async () => {
         const responseBody = { success: true, prediction: { id: 'pred-1' } };

         // Create only valid keys
         await storeIdempotencyResult(
            userId,
            endpoint,
            'key-1',
            requestBody,
            200,
            responseBody
         );

         await storeIdempotencyResult(
            userId,
            endpoint,
            'key-2',
            requestBody,
            200,
            responseBody
         );

         // Run cleanup
         const deleted = await cleanupExpiredIdempotencyKeys();

         expect(deleted).toBe(0);

         // Verify all keys still exist
         const keys = await prisma.idempotencyKey.findMany({
            where: { userId },
         });

         expect(keys.length).toBe(2);
      });
   });

   describe('Integration: Full idempotency flow', () => {
      it('should handle complete request retry scenario', async () => {
         const responseBody = { success: true, prediction: { id: 'pred-1' } };

         // First request - new key
         let result = await checkIdempotency(
            userId,
            endpoint,
            idempotencyKey,
            requestBody
         );
         expect(result.isIdempotent).toBe(false);

         // Store result
         await storeIdempotencyResult(
            userId,
            endpoint,
            idempotencyKey,
            requestBody,
            200,
            responseBody
         );

         // Retry with same key - should get cached response
         result = await checkIdempotency(
            userId,
            endpoint,
            idempotencyKey,
            requestBody
         );
         expect(result.isIdempotent).toBe(true);
         expect(result.cachedResponse?.body).toEqual(responseBody);

         // Another retry - should still get cached response
         result = await checkIdempotency(
            userId,
            endpoint,
            idempotencyKey,
            requestBody
         );
         expect(result.isIdempotent).toBe(true);
         expect(result.cachedResponse?.body).toEqual(responseBody);
      });

      it('should handle error response caching', async () => {
         const errorResponse = {
            success: false,
            error: 'Insufficient balance',
         };

         // Store error response
         await storeIdempotencyResult(
            userId,
            endpoint,
            idempotencyKey,
            requestBody,
            400,
            errorResponse
         );

         // Retry should return cached error
         const result = await checkIdempotency(
            userId,
            endpoint,
            idempotencyKey,
            requestBody
         );

         expect(result.isIdempotent).toBe(true);
         expect(result.cachedResponse?.status).toBe(400);
         expect(result.cachedResponse?.body).toEqual(errorResponse);
      });
   });
});
