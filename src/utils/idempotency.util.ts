import { createHash } from 'crypto';
import logger from './logger';
import { prisma } from '../lib/prisma';

/**
 * Configuration for idempotency key handling
 */
export interface IdempotencyConfig {
   ttlMinutes?: number;
   ttlHours?: number;
   hashAlgorithm?: string;
}

/**
 * Result of idempotency check
 */
export interface IdempotencyCheckResult {
   isIdempotent: boolean;
   cachedResponse?: {
      status: number;
      body: any;
   };
   error?: string;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: IdempotencyConfig = {
   ttlMinutes: 10,
   hashAlgorithm: 'sha256',
};

function stableStringify(value: any): string {
   if (value === null || typeof value !== 'object') {
      return JSON.stringify(value) ?? 'undefined';
   }

   if (Array.isArray(value)) {
      return `[${value.map(stableStringify).join(',')}]`;
   }

   return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
}

/**
 * Generates a hash of the request body for mutation detection
 * Ensures that retries with different payloads are treated as new requests
 */
function hashRequestBody(body: any): string {
   const bodyStr = stableStringify(body);
   return createHash('sha256').update(bodyStr).digest('hex');
}

/**
 * Checks if a request is idempotent (has been seen before)
 * Returns cached response if found and valid
 *
 * @param userId - User ID for scoping
 * @param endpoint - API endpoint (e.g., '/api/predictions/submit')
 * @param idempotencyKey - Client-provided idempotency key
 * @param requestBody - Request body for mutation detection
 * @param config - Idempotency configuration
 * @returns Idempotency check result with cached response if applicable
 *
 * @example
 * const result = await checkIdempotency(
 *   userId,
 *   '/api/predictions/submit',
 *   req.headers['idempotency-key'],
 *   req.body
 * );
 *
 * if (result.isIdempotent && result.cachedResponse) {
 *   return res.status(result.cachedResponse.status).json(result.cachedResponse.body);
 * }
 */
export async function checkIdempotency(
   userId: string,
   endpoint: string,
   idempotencyKey: string,
   requestBody: any,
   config: IdempotencyConfig = {}
): Promise<IdempotencyCheckResult> {
   try {
      // Hash the request body to detect mutations
      const requestHash = hashRequestBody(requestBody);

      // Look for existing idempotency key
      const existing = await prisma.idempotencyKey.findUnique({
         where: {
            userId_endpoint_idempotencyKey: {
               userId,
               endpoint,
               idempotencyKey,
            },
         },
      });

      if (!existing) {
         // Key not found - this is a new request
         return { isIdempotent: false };
      }

      // Check if key has expired
      if (existing.expiresAt < new Date()) {
         logger.warn('Idempotency key expired', {
            userId,
            endpoint,
            idempotencyKey,
            expiresAt: existing.expiresAt,
         });

         // Delete expired key
         await prisma.idempotencyKey.delete({ where: { id: existing.id } });

         return { isIdempotent: false };
      }

      // Check if request body matches (detect mutations)
      if (existing.requestHash !== requestHash) {
         logger.warn('Idempotency key mutation detected', {
            userId,
            endpoint,
            idempotencyKey,
            expectedHash: existing.requestHash,
            actualHash: requestHash,
         });

         return {
            isIdempotent: true,
            error: 'Idempotency key reused with different request body',
         };
      }

      // Return cached response
      logger.info('Idempotency key cache hit', {
         userId,
         endpoint,
         idempotencyKey,
         status: existing.responseStatus,
      });

      return {
         isIdempotent: true,
         cachedResponse: {
            status: existing.responseStatus,
            body: existing.responseBody,
         },
      };
   } catch (error) {
      logger.error('Idempotency check failed', {
         error: error instanceof Error ? error.message : 'Unknown error',
         userId,
         endpoint,
         idempotencyKey,
      });

      // On error, allow request to proceed (fail open)
      return { isIdempotent: false };
   }
}

/**
 * Stores the result of an idempotent operation for future retries
 *
 * @param userId - User ID for scoping
 * @param endpoint - API endpoint
 * @param idempotencyKey - Client-provided idempotency key
 * @param requestBody - Request body for mutation detection
 * @param responseStatus - HTTP status code of the response
 * @param responseBody - Response body to cache
 * @param config - Idempotency configuration
 *
 * @example
 * await storeIdempotencyResult(
 *   userId,
 *   '/api/predictions/submit',
 *   req.headers['idempotency-key'],
 *   req.body,
 *   200,
 *   { success: true, prediction: {...} }
 * );
 */
export async function storeIdempotencyResult(
   userId: string,
   endpoint: string,
   idempotencyKey: string,
   requestBody: any,
   responseStatus: number,
   responseBody: any,
   config: IdempotencyConfig = {}
): Promise<void> {
   try {
      const requestHash = hashRequestBody(requestBody);
      const ttlMinutes =
         config.ttlMinutes ??
         (config.ttlHours !== undefined
            ? config.ttlHours * 60
            : DEFAULT_CONFIG.ttlMinutes!);
      const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

      // Upsert idempotency key (update if exists, create if not)
      await prisma.idempotencyKey.upsert({
         where: {
            userId_endpoint_idempotencyKey: {
               userId,
               endpoint,
               idempotencyKey,
            },
         },
         create: {
            userId,
            endpoint,
            idempotencyKey,
            requestHash,
            responseStatus,
            responseBody,
            expiresAt,
         },
         update: {
            requestHash,
            responseStatus,
            responseBody,
            expiresAt,
         },
      });

      logger.debug('Idempotency result stored', {
         userId,
         endpoint,
         idempotencyKey,
         status: responseStatus,
         expiresAt,
      });
   } catch (error) {
      logger.error('Failed to store idempotency result', {
         error: error instanceof Error ? error.message : 'Unknown error',
         userId,
         endpoint,
         idempotencyKey,
      });

      // Don't throw - idempotency is best-effort
   }
}

/**
 * Cleans up expired idempotency keys
 * Should be called periodically (e.g., by a scheduled job)
 *
 * @returns Number of keys deleted
 *
 * @example
 * const deleted = await cleanupExpiredIdempotencyKeys();
 * logger.info(`Cleaned up ${deleted} expired idempotency keys`);
 */
export async function cleanupExpiredIdempotencyKeys(): Promise<number> {
   try {
      const result = await prisma.idempotencyKey.deleteMany({
         where: {
            expiresAt: {
               lt: new Date(),
            },
         },
      });

      logger.info('Cleaned up expired idempotency keys', {
         count: result.count,
      });

      return result.count;
   } catch (error) {
      logger.error('Failed to cleanup expired idempotency keys', {
         error: error instanceof Error ? error.message : 'Unknown error',
      });

      return 0;
   }
}

/**
 * Validates idempotency key format
 * Keys should be UUIDs or similar unique identifiers
 *
 * @param key - Idempotency key to validate
 * @returns true if valid, false otherwise
 */
export function isValidIdempotencyKey(key: string): boolean {
   if (!key || typeof key !== 'string') {
      return false;
   }

   // Allow UUIDs and alphanumeric strings with hyphens/underscores
   // Minimum 8 characters, maximum 255 characters
   const pattern = /^[a-zA-Z0-9_-]{8,255}$/;
   return pattern.test(key);
}
