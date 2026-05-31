import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { withRetry, retryOrThrow } from '../utils/retry.util';

describe('Retry Utility', () => {
   describe('withRetry', () => {
      it('should succeed on first attempt', async () => {
         const operation = jest.fn().mockResolvedValue('success');

         const result = await withRetry(operation, 'testOp', {
            maxAttempts: 3,
         });

         expect(result.success).toBe(true);
         expect(result.data).toBe('success');
         expect(result.attemptsUsed).toBe(1);
         expect(operation).toHaveBeenCalledTimes(1);
      });

      it('should retry on transient failure and succeed', async () => {
         const operation = jest
            .fn()
            .mockRejectedValueOnce(new Error('P2034: Transaction conflict'))
            .mockResolvedValueOnce('success');

         const result = await withRetry(operation, 'testOp', {
            maxAttempts: 3,
            initialDelayMs: 10,
         });

         expect(result.success).toBe(true);
         expect(result.data).toBe('success');
         expect(result.attemptsUsed).toBe(2);
         expect(operation).toHaveBeenCalledTimes(2);
      });

      it('should fail after max attempts exceeded', async () => {
         const operation = jest
            .fn()
            .mockRejectedValue(new Error('P2034: Transaction conflict'));

         const result = await withRetry(operation, 'testOp', {
            maxAttempts: 3,
            initialDelayMs: 10,
         });

         expect(result.success).toBe(false);
         expect(result.error).toBeDefined();
         expect(result.attemptsUsed).toBe(3);
         expect(operation).toHaveBeenCalledTimes(3);
      });

      it('should not retry on non-retryable errors', async () => {
         const operation = jest
            .fn()
            .mockRejectedValue(new Error('Invalid input'));

         const result = await withRetry(operation, 'testOp', {
            maxAttempts: 3,
            initialDelayMs: 10,
         });

         expect(result.success).toBe(false);
         expect(result.attemptsUsed).toBe(1);
         expect(operation).toHaveBeenCalledTimes(1);
      });

      it('should apply exponential backoff', async () => {
         const operation = jest
            .fn()
            .mockRejectedValueOnce(new Error('P2034: Transaction conflict'))
            .mockRejectedValueOnce(new Error('P2034: Transaction conflict'))
            .mockResolvedValueOnce('success');

         const startTime = Date.now();
         const result = await withRetry(operation, 'testOp', {
            maxAttempts: 3,
            initialDelayMs: 50,
            backoffMultiplier: 2,
         });

         const duration = Date.now() - startTime;

         expect(result.success).toBe(true);
         expect(result.attemptsUsed).toBe(3);
         // Should have waited at least 50ms + 100ms = 150ms
         expect(duration).toBeGreaterThanOrEqual(100);
      });

      it('should respect max backoff delay', async () => {
         const operation = jest
            .fn()
            .mockRejectedValue(new Error('P2034: Transaction conflict'));

         const startTime = Date.now();
         await withRetry(operation, 'testOp', {
            maxAttempts: 4,
            initialDelayMs: 100,
            maxDelayMs: 200,
            backoffMultiplier: 2,
         });

         const duration = Date.now() - startTime;

         // With max delay of 200ms and 3 retries, should be roughly 100 + 200 + 200 = 500ms
         expect(duration).toBeLessThan(1000);
      });

      it('should handle custom isRetryable function', async () => {
         const operation = jest
            .fn()
            .mockRejectedValueOnce({ code: 'CUSTOM_ERROR' })
            .mockResolvedValueOnce('success');

         const result = await withRetry(operation, 'testOp', {
            maxAttempts: 3,
            initialDelayMs: 10,
            isRetryable: error => error?.code === 'CUSTOM_ERROR',
         });

         expect(result.success).toBe(true);
         expect(result.attemptsUsed).toBe(2);
      });

      it('should track total duration', async () => {
         const operation = jest
            .fn()
            .mockRejectedValueOnce(new Error('P2034: Transaction conflict'))
            .mockResolvedValueOnce('success');

         const result = await withRetry(operation, 'testOp', {
            maxAttempts: 3,
            initialDelayMs: 50,
         });

         expect(result.totalDurationMs).toBeGreaterThanOrEqual(50);
      });

      it('should recognize Prisma transaction conflict errors', async () => {
         const operation = jest
            .fn()
            .mockRejectedValueOnce({ code: 'P2034' })
            .mockResolvedValueOnce('success');

         const result = await withRetry(operation, 'testOp', {
            maxAttempts: 3,
            initialDelayMs: 10,
         });

         expect(result.success).toBe(true);
         expect(result.attemptsUsed).toBe(2);
      });

      it('should recognize network timeout errors', async () => {
         const operation = jest
            .fn()
            .mockRejectedValueOnce({ code: 'ETIMEDOUT' })
            .mockResolvedValueOnce('success');

         const result = await withRetry(operation, 'testOp', {
            maxAttempts: 3,
            initialDelayMs: 10,
         });

         expect(result.success).toBe(true);
         expect(result.attemptsUsed).toBe(2);
      });

      it('should recognize timeout message errors', async () => {
         const operation = jest
            .fn()
            .mockRejectedValueOnce(new Error('Operation timeout after 5000ms'))
            .mockResolvedValueOnce('success');

         const result = await withRetry(operation, 'testOp', {
            maxAttempts: 3,
            initialDelayMs: 10,
         });

         expect(result.success).toBe(true);
         expect(result.attemptsUsed).toBe(2);
      });
   });

   describe('retryOrThrow', () => {
      it('should return data on success', async () => {
         const operation = jest.fn().mockResolvedValue('success');

         const result = await retryOrThrow(operation, 'testOp', {
            maxAttempts: 3,
         });

         expect(result).toBe('success');
      });

      it('should throw on failure', async () => {
         const operation = jest
            .fn()
            .mockRejectedValue(new Error('Operation failed'));

         await expect(
            retryOrThrow(operation, 'testOp', { maxAttempts: 1 })
         ).rejects.toThrow('Operation failed');
      });

      it('should retry before throwing', async () => {
         const operation = jest
            .fn()
            .mockRejectedValueOnce(new Error('P2034: Transaction conflict'))
            .mockResolvedValueOnce('success');

         const result = await retryOrThrow(operation, 'testOp', {
            maxAttempts: 3,
            initialDelayMs: 10,
         });

         expect(result).toBe('success');
         expect(operation).toHaveBeenCalledTimes(2);
      });
   });
});
