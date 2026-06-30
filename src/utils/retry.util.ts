import logger from './logger';

/**
 * Configuration for retry policy
 */
export interface RetryPolicy {
   maxAttempts?: number;
   initialDelayMs?: number;
   maxDelayMs?: number;
   backoffMultiplier?: number;
   isRetryable?: (error: any) => boolean;
}

/**
 * Result of a retried operation
 */
export interface RetryResult<T> {
   success: boolean;
   data?: T;
   error?: Error;
   attemptsUsed: number;
   totalDurationMs: number;
}

/**
 * Retryable error types that should trigger retry logic
 */
const RETRYABLE_ERROR_CODES = [
   'P2034', // Transaction conflict
   'P2025', // Record not found (can happen in concurrent scenarios)
   'ECONNREFUSED', // Connection refused
   'ETIMEDOUT', // Timeout
   'ENOTFOUND', // DNS not found
];

/**
 * Determines if an error is retryable
 */
function isRetryableError(error: any): boolean {
   if (!error) return false;

   // Prisma errors
   if (error.code && RETRYABLE_ERROR_CODES.includes(error.code)) {
      return true;
   }

   // Check message for error codes
   if (error.message) {
      for (const code of RETRYABLE_ERROR_CODES) {
         if (error.message.includes(code)) {
            return true;
         }
      }
   }

   // Network errors
   if (
      error.code &&
      ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].includes(error.code)
   ) {
      return true;
   }

   // Timeout errors
   if (error.message && error.message.includes('timeout')) {
      return true;
   }

   return false;
}

/**
 * Executes an async operation with exponential backoff retry logic
 * Useful for transactional operations that may fail due to conflicts or temporary issues
 *
 * @param operation - The async function to execute
 * @param operationName - Name for logging
 * @param policy - Retry policy configuration
 * @returns Promise with retry result including attempt count and timing
 *
 * @example
 * const result = await withRetry(
 *   () => predictionService.submitPrediction(userId, roundId, amount, side),
 *   'submitPrediction',
 *   { maxAttempts: 3, initialDelayMs: 100 }
 * );
 *
 * if (!result.success) {
 *   logger.error('Operation failed after retries', { error: result.error });
 * }
 */
export async function withRetry<T>(
   operation: () => Promise<T>,
   operationName: string,
   policy: RetryPolicy = {}
): Promise<RetryResult<T>> {
   const {
      maxAttempts = 3,
      initialDelayMs = 100,
      maxDelayMs = 5000,
      backoffMultiplier = 2,
      isRetryable = isRetryableError,
   } = policy;

   let lastError: Error | undefined;
   let delayMs = initialDelayMs;
   const startTime = Date.now();

   for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
         const data = await operation();
         const totalDurationMs = Date.now() - startTime;

         if (attempt > 1) {
            logger.info(
               `${operationName} succeeded after ${attempt} attempts`,
               {
                  totalDurationMs,
                  operationName,
               }
            );
         }

         return {
            success: true,
            data,
            attemptsUsed: attempt,
            totalDurationMs,
         };
      } catch (error) {
         lastError = error instanceof Error ? error : new Error(String(error));

         // Check if error is retryable
         if (!isRetryable(error) || attempt === maxAttempts) {
            const totalDurationMs = Date.now() - startTime;
            logger.error(`${operationName} failed after ${attempt} attempts`, {
               error: lastError.message,
               code: (error as any)?.code,
               totalDurationMs,
               operationName,
            });

            return {
               success: false,
               error: lastError,
               attemptsUsed: attempt,
               totalDurationMs,
            };
         }

         // Calculate backoff delay
         delayMs = Math.min(delayMs * backoffMultiplier, maxDelayMs);

         logger.warn(
            `${operationName} attempt ${attempt} failed, retrying in ${delayMs}ms`,
            {
               error: lastError.message,
               code: (error as any)?.code,
               attempt,
               nextDelayMs: delayMs,
               operationName,
            }
         );

         // Wait before retry
         await new Promise(resolve => setTimeout(resolve, delayMs));
      }
   }

   // Should not reach here, but handle just in case
   const totalDurationMs = Date.now() - startTime;
   return {
      success: false,
      error: lastError || new Error('Unknown error'),
      attemptsUsed: maxAttempts,
      totalDurationMs,
   };
}

/**
 * Wraps an operation with retry logic and throws on failure
 * Simpler API for cases where you want to throw on failure
 */
export async function retryOrThrow<T>(
   operation: () => Promise<T>,
   operationName: string,
   policy?: RetryPolicy
): Promise<T> {
   const result = await withRetry(operation, operationName, policy);

   if (!result.success) {
      throw result.error;
   }

   return result.data!;
}
