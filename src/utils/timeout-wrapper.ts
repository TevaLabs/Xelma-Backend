import logger from './logger';

/**
 * Configuration options for timeout/cancellation wrapper
 */
export interface TimeoutWrapperOptions {
  timeoutMs: number;
  operationName: string;
  retries?: number;
  backoffMultiplier?: number;
  maxBackoffMs?: number;
}

/**
 * Result of a timeout-wrapped operation
 */
export interface TimeoutResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  durationMs: number;
  retriesUsed: number;
  timedOut: boolean;
}

/**
 * Wraps an async operation with timeout and retry logic
 * Provides structured timeout/cancellation semantics and logging
 * 
 * @param operation - The async function to execute
 * @param options - Configuration for timeout and retries
 * @returns Promise with structured result including timing and retry info
 * 
 * @example
 * const result = await withTimeout(
 *   () => externalApi.call(),
 *   { timeoutMs: 5000, operationName: 'fetchPrice', retries: 3 }
 * );
 * 
 * if (result.timedOut) {
 *   logger.warn('Operation timed out', { result });
 * }
 */
export async function withTimeout<T>(
  operation: () => Promise<T>,
  options: TimeoutWrapperOptions
): Promise<TimeoutResult<T>> {
  const { timeoutMs, operationName, retries = 1, backoffMultiplier = 2, maxBackoffMs = 8000 } = options;
  
  let lastError: Error | undefined;
  let retriesUsed = 0;
  const startTime = Date.now();

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      let data: T;
      try {
        data = await Promise.race([
          operation(),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener('abort', () => {
              reject(new Error(`Operation timeout after ${timeoutMs}ms`));
            });
          }),
        ]);
      } finally {
        clearTimeout(timeoutId);
      }

      const durationMs = Date.now() - startTime;
      logger.debug(`${operationName} completed successfully`, {
        durationMs,
        attempt: attempt + 1,
        timeoutMs,
      });

      return {
        success: true,
        data,
        durationMs,
        retriesUsed: attempt,
        timedOut: false,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      retriesUsed = attempt + 1;
      const isTimeout = lastError.message.includes('timeout');

      if (attempt < retries - 1) {
        const backoffMs = Math.min(1000 * (backoffMultiplier ** attempt), maxBackoffMs);
        logger.warn(`${operationName} failed (attempt ${attempt + 1}/${retries}), retrying in ${backoffMs}ms`, {
          error: lastError.message,
          isTimeout,
        });
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      } else {
        const durationMs = Date.now() - startTime;
        logger.error(`${operationName} failed after ${retries} attempt(s)`, {
          error: lastError.message,
          isTimeout,
          durationMs,
          retriesUsed,
          timeoutMs,
        });

        return {
          success: false,
          error: lastError,
          durationMs,
          retriesUsed,
          timedOut: isTimeout,
        };
      }
    }
  }

  // Should not reach here, but handle as safety net
  const durationMs = Date.now() - startTime;
  return {
    success: false,
    error: lastError || new Error('Unknown error'),
    durationMs,
    retriesUsed,
    timedOut: false,
  };
}

/**
 * Promise-based timeout utility
 * Rejects if operation takes longer than specified timeout
 * 
 * @example
 * try {
 *   const result = await timeoutPromise(fetch(url), 5000);
 * } catch (error) {
 *   if (error.message.includes('timeout')) {
 *     // Handle timeout
 *   }
 * }
 */
export function timeoutPromise<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Operation timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

/**
 * Create an AbortSignal that times out after specified duration
 * Useful for passing to fetch/axios with timeout support
 * 
 * @example
 * const signal = createTimeoutSignal(5000);
 * const response = await fetch(url, { signal });
 */
export function createTimeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}
