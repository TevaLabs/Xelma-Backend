import logger from './logger';

/**
 * Options for `withTimeout` wrapper.
 */
export interface TimeoutWrapperOptions {
  timeoutMs: number;
  operationName: string;
  retries?: number;
  backoffMultiplier?: number;
  maxBackoffMs?: number;
}

/**
 * Result of a timeout-wrapped operation.
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
 * Operation function signature which optionally accepts an `AbortSignal`.
 */
export type TimeoutOperation<T> = (signal?: AbortSignal) => Promise<T>;

/**
 * Wraps an async operation with timeout and retry logic.
 * Provides structured timeout/cancellation semantics and logging.
 *
 * @param operation - The async function to execute. Optionally accepts an `AbortSignal`.
 * @param options - Configuration for timeout and retries.
 * @returns Promise with structured result including timing and retry info.
 */
export async function withTimeout<T>(
  operation: TimeoutOperation<T>,
  options: TimeoutWrapperOptions
): Promise<TimeoutResult<T>> {
  const {
    timeoutMs,
    operationName,
    retries = 1,
    backoffMultiplier = 2,
    maxBackoffMs = 8000,
  } = options;

  let lastError: Error | undefined;
  let retriesUsed = 0;
  const startTime = Date.now();

  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController();
    let timeoutId: NodeJS.Timeout | undefined;

    try {
      const operationPromise = operation(controller.signal);

      // Attach a dummy catch handler to the raw background promise to prevent
      // unhandled promise rejections if the operation fails or rejects after timing out.
      operationPromise.catch(() => {
        // Handled silently to avoid dangling unhandled rejection
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(new Error(`${operationName} timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      let data: T;
      try {
        data = await Promise.race([operationPromise, timeoutPromise]);
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
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
      const isTimeout =
        lastError.message.toLowerCase().includes('timeout') || controller.signal.aborted;

      if (attempt < retries - 1) {
        const backoffMs = Math.min(1000 * Math.pow(backoffMultiplier, attempt), maxBackoffMs);
        logger.warn(
          `${operationName} failed (attempt ${attempt + 1}/${retries}), retrying in ${backoffMs}ms`,
          {
            error: lastError.message,
            isTimeout,
          }
        );
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
 * Promise-based timeout utility.
 * Rejects if operation takes longer than specified timeout.
 */
export function timeoutPromise<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutP = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Operation timeout after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  // Attach catch to prevent unhandled rejection on late failure
  promise.catch(() => {});

  return Promise.race([promise, timeoutP]).finally(() => {
    clearTimeout(timeoutId);
  });
}

/**
 * Create an AbortSignal that times out after specified duration.
 */
export function createTimeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}
