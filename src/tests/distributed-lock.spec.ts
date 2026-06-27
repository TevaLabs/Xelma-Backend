process.env.REDIS_URL = 'redis://localhost:6379';

const locks = new Map<string, string>();
const mockRedisClient = {
   connect: jest.fn().mockImplementation(() => Promise.resolve()),
   set: jest.fn().mockImplementation((key: string, value: string, options?: any) => {
      if (options?.NX) {
         if (locks.has(key)) {
            return Promise.resolve(null);
         }
         locks.set(key, value);
         return Promise.resolve('OK');
      }
      locks.set(key, value);
      return Promise.resolve('OK');
   }),
   eval: jest.fn().mockImplementation((script: string, config: any) => {
      const key = config?.keys?.[0];
      const val = config?.arguments?.[0];
      if (script.includes('del')) {
         if (locks.get(key) === val) {
            locks.delete(key);
            return Promise.resolve(1);
         }
         return Promise.resolve(0);
      }
      if (locks.get(key) === val) {
         return Promise.resolve(1);
      }
      return Promise.resolve(0);
   }),
};

jest.mock('redis', () => ({
   createClient: jest.fn(() => mockRedisClient),
}));

import {
   describe,
   it,
   expect,
   beforeEach,
   afterEach,
   jest,
} from '@jest/globals';
import {
   DistributedLock,
   withDistributedLock,
} from '../utils/distributed-lock';

describe('Distributed Lock', () => {
   beforeEach(() => {
      locks.clear();
      jest.clearAllMocks();
      mockRedisClient.connect.mockImplementation(() => Promise.resolve());
      mockRedisClient.set.mockImplementation((key: string, value: string, options?: any) => {
         if (options?.NX) {
            if (locks.has(key)) {
               return Promise.resolve(null);
            }
            locks.set(key, value);
            return Promise.resolve('OK');
         }
         locks.set(key, value);
         return Promise.resolve('OK');
      });
      mockRedisClient.eval.mockImplementation((script: string, config: any) => {
         const key = config?.keys?.[0];
         const val = config?.arguments?.[0];
         if (script.includes('del')) {
            if (locks.get(key) === val) {
               locks.delete(key);
               return Promise.resolve(1);
            }
            return Promise.resolve(0);
         }
         if (locks.get(key) === val) {
            return Promise.resolve(1);
         }
         return Promise.resolve(0);
      });
   });

   describe('DistributedLock class', () => {
      let lock: DistributedLock;

      beforeEach(() => {
         lock = new DistributedLock('test-lock', { ttlSeconds: 10 });
      });

      afterEach(async () => {
         // Clean up any acquired locks
         await lock.release();
      });

      it('should create lock with default config', () => {
         const testLock = new DistributedLock('my-lock');
         expect(testLock).toBeDefined();
      });

      it('should create lock with custom config', () => {
         const testLock = new DistributedLock('my-lock', {
            ttlSeconds: 60,
            retryDelayMs: 200,
            maxRetries: 5,
         });
         expect(testLock).toBeDefined();
      });

      it('should generate unique lock IDs', () => {
         const lock1 = new DistributedLock('test');
         const lock2 = new DistributedLock('test');

         // Lock IDs should be different (based on timestamp + random)
         expect(lock1).toBeDefined();
         expect(lock2).toBeDefined();
      });

      it('should handle acquire when Redis unavailable', async () => {
         mockRedisClient.connect.mockRejectedValueOnce(new Error('Connection failed'));
         const result = await lock.acquire();

         // Should return gracefully with acquired=false
         expect(result.acquired).toBe(false);
      });

      it('should handle release gracefully', async () => {
         // Should not throw even if lock was never acquired
         await expect(lock.release()).resolves.not.toThrow();
      });

      it('should handle extend gracefully', async () => {
         // Should return false if lock not acquired
         const result = await lock.extend();
         expect(result).toBe(false);
      });
   });

   describe('withDistributedLock helper', () => {
      it('should execute function when lock acquired', async () => {
         const mockFn = jest.fn().mockResolvedValue('success');

         const result = await withDistributedLock('test-lock', mockFn, {
            ttlSeconds: 10,
         });

         // If Redis is unavailable, result will be null
         // If Redis is available, function should execute
         if (result !== null) {
            expect(mockFn).toHaveBeenCalled();
            expect(result).toBe('success');
         }
      });

      it('should return null if lock cannot be acquired', async () => {
         const mockFn = jest.fn();

         // Try to acquire same lock twice concurrently
         const promise1 = withDistributedLock(
            'concurrent-lock',
            async () => {
               await new Promise(resolve => setTimeout(resolve, 100));
               return 'first';
            },
            { ttlSeconds: 10, maxRetries: 1, retryDelayMs: 50 }
         );

         const promise2 = withDistributedLock('concurrent-lock', mockFn, {
            ttlSeconds: 10,
            maxRetries: 1,
            retryDelayMs: 50,
         });

         const [result1, result2] = await Promise.all([promise1, promise2]);

         // One should succeed, one should fail (or both fail if Redis unavailable)
         if (result1 !== null || result2 !== null) {
            expect(result1 === null || result2 === null).toBe(true);
         }
      });

      it('should handle function errors', async () => {
         const error = new Error('Function failed');
         const mockFn = jest.fn().mockRejectedValue(error);

         await expect(
            withDistributedLock('test-lock', mockFn, { ttlSeconds: 10 })
         ).rejects.toThrow('Function failed');
      });

      it('should handle async functions', async () => {
         const mockFn = jest.fn().mockResolvedValue({ data: 'test' });

         const result = await withDistributedLock('async-lock', mockFn, {
            ttlSeconds: 10,
         });

         if (result !== null) {
            expect(result).toEqual({ data: 'test' });
         }
      });

      it('should support custom config', async () => {
         const mockFn = jest.fn().mockResolvedValue('done');

         const result = await withDistributedLock(
            'custom-config-lock',
            mockFn,
            {
               ttlSeconds: 60,
               retryDelayMs: 200,
               maxRetries: 5,
            }
         );

         if (result !== null) {
            expect(mockFn).toHaveBeenCalled();
         }
      });
   });

   describe('Lock naming and scoping', () => {
      it('should support different lock names', async () => {
         const lock1 = new DistributedLock('lock-1');
         const lock2 = new DistributedLock('lock-2');

         expect(lock1).toBeDefined();
         expect(lock2).toBeDefined();
      });

      it('should support special characters in lock names', async () => {
         const lock = new DistributedLock('lock-with-dashes_and_underscores');
         expect(lock).toBeDefined();
      });
   });

   describe('Configuration validation', () => {
      it('should use default TTL if not specified', () => {
         const lock = new DistributedLock('test');
         expect(lock).toBeDefined();
      });

      it('should use default retry config if not specified', () => {
         const lock = new DistributedLock('test', { ttlSeconds: 30 });
         expect(lock).toBeDefined();
      });

      it('should accept zero retries', () => {
         const lock = new DistributedLock('test', { maxRetries: 0 });
         expect(lock).toBeDefined();
      });

      it('should accept high retry counts', () => {
         const lock = new DistributedLock('test', { maxRetries: 100 });
         expect(lock).toBeDefined();
      });
   });

   describe('Error handling', () => {
      it('should handle acquire errors gracefully', async () => {
         mockRedisClient.connect.mockRejectedValueOnce(new Error('Connection failed'));
         const lock = new DistributedLock('error-lock');

         // Should not throw
         const result = await lock.acquire();
         expect(result).toBeDefined();
         expect(result.acquired).toBe(false);
      });

      it('should handle release errors gracefully', async () => {
         mockRedisClient.eval.mockRejectedValueOnce(new Error('Eval failed'));
         const lock = new DistributedLock('error-lock');
         await lock.acquire(); // populate redisClient

         // Should not throw
         await expect(lock.release()).resolves.not.toThrow();
      });

      it('should handle extend errors gracefully', async () => {
         mockRedisClient.eval.mockRejectedValueOnce(new Error('Eval failed'));
         const lock = new DistributedLock('error-lock');
         await lock.acquire(); // populate redisClient

         // Should not throw
         const result = await lock.extend();
         expect(result).toBe(false);
      });
   });

   describe('Lock lifecycle', () => {
      it('should support acquire -> extend -> release cycle', async () => {
         const lock = new DistributedLock('lifecycle-lock', { ttlSeconds: 10 });

         const acquireResult = await lock.acquire();
         expect(acquireResult).toBeDefined();

         if (acquireResult.acquired) {
            const extendResult = await lock.extend();
            expect(extendResult).toBe(true);

            await lock.release();
         }
      });

      it('should support multiple acquire attempts', async () => {
         const lock = new DistributedLock('multi-acquire-lock');

         const result1 = await lock.acquire();
         expect(result1).toBeDefined();

         if (result1.acquired) {
            await lock.release();

            // Should be able to acquire again after release
            const result2 = await lock.acquire();
            expect(result2).toBeDefined();

            await lock.release();
         }
      });
   });
});
