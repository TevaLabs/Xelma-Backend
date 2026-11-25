import { NextFunction, Request, Response, Router } from 'express';
import {
   authenticateUser,
   AuthenticatedRequest,
} from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/errorHandler.middleware';
import {
   batchPredictionRateLimiter,
   predictionRateLimiter,
} from '../middleware/rateLimiter.middleware';
import { validate } from '../middleware/validate.middleware';
import {
   batchSubmitPredictionsSchema,
   submitPredictionSchema,
} from '../schemas/predictions.schema';
import predictionService, {
   type PredictionRow,
   type UserPredictionRow,
} from '../services/prediction.service';
import {
   acquireIdempotencyLock,
   releaseIdempotencyLock,
   IDEMPOTENCY_STORE_UNAVAILABLE,
   IdempotencyStoreUnavailableError,
   isValidIdempotencyKey,
   storeIdempotencyResult,
} from '../utils/idempotency.util';
import {
   ConflictError,
   ErrorCode,
   ExternalServiceError,
   ValidationError,
} from '../utils/errors';
import { serializePrediction, serializeRound } from '../serializers/monetary.serializer';
import { csvRow } from '../utils/csv.util';
import { serializeMoney, serializeNullableMoney } from '../utils/decimal.util';
import logger from '../utils/logger';

const router = Router();
const SUBMIT_PREDICTION_ENDPOINT = '/api/predictions/submit';

function buildSubmitPredictionResponse(prediction: PredictionRow) {
   return {
      success: true,
      prediction: serializePrediction({
         id: prediction.id,
         roundId: prediction.roundId,
         userId: prediction.userId,
         amount: prediction.amount,
         side: prediction.side,
         priceRange: prediction.priceRange ?? null,
         createdAt:
            prediction.createdAt?.toISOString?.() ?? prediction.createdAt,
      }),
   };
}

/**
 * @openapi
 * /api/predictions/submit:
 *   post:
 *     tags: [Predictions]
 *     summary: Submit a prediction
 *     description: Submit a prediction for a round. Supports idempotency via Idempotency-Key header for safe retries.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         schema:
 *           type: string
 *         description: Unique key for idempotent request handling. Duplicate identical requests return the cached response for 10 minutes; reuse with a different request body returns 409.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [roundId, amount, side]
 *             properties:
 *               roundId:
 *                 type: string
 *               amount:
 *                 type: number
 *               side:
 *                 type: string
 *                 enum: [UP, DOWN]
 *               priceRange:
 *                 type: object
 *                 properties:
 *                   min:
 *                     type: number
 *                   max:
 *                     type: number
 *     responses:
 *       200:
 *         description: Prediction submitted
 *       409:
 *         description: Idempotency key reused with a different request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               error: ConflictError
 *               message: Idempotency key reused with different request body
 *               code: IDEMPOTENCY_KEY_CONFLICT
 */
router.post(
   '/submit',
   authenticateUser,
   predictionRateLimiter,
   validate(submitPredictionSchema),
   asyncHandler(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      const { roundId, amount, side, priceRange } = req.body;
      const userId = req.user.userId;
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
      let lockAcquired = false;
      let operationCompleted = false;

      try {
         // Validate idempotency key if provided
         if (idempotencyKey && !isValidIdempotencyKey(idempotencyKey)) {
            throw new ValidationError(
               'Invalid Idempotency-Key format. Must be 8-255 alphanumeric characters.'
            );
         }

         // Acquire in-process/DB idempotency lock (mutex + replay cache)
         if (idempotencyKey) {
            const lockResult = await acquireIdempotencyLock(
               userId,
               SUBMIT_PREDICTION_ENDPOINT,
               idempotencyKey,
               { roundId, amount, side, priceRange },
            );

            if (lockResult.isIdempotent && lockResult.cachedResponse) {
               return res
                  .status(lockResult.cachedResponse.status)
                  .json(lockResult.cachedResponse.body);
            }

            if (lockResult.error === IDEMPOTENCY_STORE_UNAVAILABLE) {
               throw new ExternalServiceError(
                  'Idempotency store unavailable. Please try again.',
                  ErrorCode.EXTERNAL_SERVICE_ERROR
               );
            }

            if (lockResult.error) {
               throw new ConflictError(
                  lockResult.error,
                  ErrorCode.IDEMPOTENCY_KEY_CONFLICT
               );
            }

            lockAcquired = !!lockResult.lockAcquired;
         }

         const prediction = await predictionService.submitPrediction(
            userId,
            roundId,
            amount,
            side,
            priceRange
         );
         operationCompleted = true;

         const responseBody = buildSubmitPredictionResponse(prediction);

         if (idempotencyKey && lockAcquired) {
            await storeIdempotencyResult(
               userId,
               SUBMIT_PREDICTION_ENDPOINT,
               idempotencyKey,
               { roundId, amount, side, priceRange },
               200,
               responseBody
            );
         }

         res.json(responseBody);
      } catch (error) {
         if (idempotencyKey && lockAcquired && !operationCompleted) {
            await releaseIdempotencyLock(userId, SUBMIT_PREDICTION_ENDPOINT, idempotencyKey);
         }

         if (error instanceof IdempotencyStoreUnavailableError) {
            return next(
               new ExternalServiceError(
                  'Idempotency store unavailable. Please try again.',
                  ErrorCode.EXTERNAL_SERVICE_ERROR
               )
            );
         }
         next(error);
      }
   })
);

/**
 * @openapi
 * /api/predictions/batch-submit:
 *   post:
 *     tags: [Predictions]
 *     summary: Submit multiple predictions at once
 *     description: |
 *       Batch submit up to 50 predictions. Rate limit: **3 batch requests per minute per user** (stricter than single submit). On limit, responds with **429**.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [predictions]
 *             properties:
 *               predictions:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [roundId, amount]
 *     responses:
 *       200:
 *         description: Batch processed. Per-item outcomes are returned even
 *           when some (or all) predictions fail; the HTTP status stays 200.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, results]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: True when at least one prediction succeeded.
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required: [index, success]
 *                     properties:
 *                       index:
 *                         type: integer
 *                       success:
 *                         type: boolean
 *                       prediction:
 *                         type: object
 *                         nullable: true
 *                       error:
 *                         type: string
 *                         nullable: true
 *       429:
 *         description: Too many batch requests
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RateLimitResponse'
 */
router.post(
   '/batch-submit',
   authenticateUser,
   batchPredictionRateLimiter,
   validate(batchSubmitPredictionsSchema),
   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const { predictions } = req.body;
      const userId = req.user.userId;

      const result = await predictionService.submitBatchPredictions(
         userId,
         predictions
      );

      // Partial failures are reported per item in `results[]`. The service's
      // `success` flag reflects whether *any* item succeeded — never overwrite
      // it with a constant `true`, which would mark an all-failed batch as a
      // success. The whole request still returns HTTP 200 so callers can read
      // every per-item outcome in one pass (all-or-nothing was the old bug).
      res.json(result);
   })
);

/**
 * @openapi
 * /api/predictions/user:
 *   get:
 *     tags: [Predictions]
 *     summary: Get user predictions
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of predictions
 */
router.get(
   '/user',
   authenticateUser,
   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user.userId;

      const predictions = await predictionService.getUserPredictions(userId);

      const serializedPredictions = predictions.map((p) =>
         serializePrediction({
            id: p.id,
            roundId: p.roundId,
            userId: p.userId,
            amount: p.amount,
            side: p.side,
            priceRange: p.priceRange,
            payout: p.payout,
            won: p.won,
            createdAt: p.createdAt?.toISOString?.() ?? p.createdAt,
            round: p.round
               ? serializeRound({
                    id: p.round.id,
                    mode: p.round.mode,
                    status: p.round.status,
                    startPrice: p.round.startPrice,
                    endPrice: p.round.endPrice,
                 })
               : null,
         }),
      );

      res.json({
         success: true,
         predictions: serializedPredictions,
      });
   })
);

const EXPORT_COLUMNS = [
   'id',
   'round_id',
   'round_mode',
   'round_status',
   'side',
   'amount',
   'price_range_min',
   'price_range_max',
   'won',
   'payout',
   'round_start_price',
   'round_end_price',
   'created_at',
] as const;

function predictionToCsvRow(p: UserPredictionRow): string {
   const range =
      p.priceRange && typeof p.priceRange === 'object' && !Array.isArray(p.priceRange)
         ? (p.priceRange as { min?: unknown; max?: unknown })
         : {};
   return csvRow([
      p.id,
      p.roundId,
      p.round?.mode,
      p.round?.status,
      p.side,
      serializeMoney(p.amount as never),
      range.min,
      range.max,
      p.won,
      serializeNullableMoney(p.payout as never),
      serializeNullableMoney(p.round?.startPrice as never),
      serializeNullableMoney(p.round?.endPrice as never),
      p.createdAt,
   ]);
}

/**
 * @openapi
 * /api/predictions/user/export:
 *   get:
 *     tags: [Predictions]
 *     summary: Export the authenticated user's predictions as CSV
 *     description: Streams every prediction of the authenticated user, newest first, as `text/csv` (RFC 4180, header row first). Rows are read in batches and written as they are produced, so the response is not buffered. Amounts and prices are 8-decimal strings.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: CSV attachment
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 *             example: "id,round_id,round_mode,round_status,side,amount,price_range_min,price_range_max,won,payout,round_start_price,round_end_price,created_at\r\n"
 *       401:
 *         description: Missing or invalid token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get(
   '/user/export',
   authenticateUser,
   asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user.userId;
      let clientGone = false;
      res.on('close', () => {
         clientGone = !res.writableFinished;
      });

      res.status(200);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
         'Content-Disposition',
         `attachment; filename="xelma-predictions-${new Date().toISOString().slice(0, 10)}.csv"`,
      );

      // Write with backpressure: wait for 'drain' when the socket is full.
      const write = async (chunk: string) => {
         if (!res.write(chunk) && !clientGone) {
            await new Promise<void>((resolve) => {
               const done = () => {
                  res.off('drain', done);
                  res.off('close', done);
                  resolve();
               };
               res.once('drain', done);
               res.once('close', done);
            });
         }
      };

      try {
         await write(csvRow(EXPORT_COLUMNS));
         for await (const batch of predictionService.streamUserPredictions(userId)) {
            if (clientGone) return;
            await write(batch.map(predictionToCsvRow).join(''));
         }
         res.end();
      } catch (error) {
         // Headers are already sent, so a JSON error body is impossible. Cut the
         // connection so the client sees a failed download, not a short file.
         logger.error('Prediction export failed mid-stream', { userId, error });
         res.destroy(error instanceof Error ? error : undefined);
      }
   }),
);

/**
 * @openapi
 * /api/predictions/round/{roundId}:
 *   get:
 *     tags: [Predictions]
 *     summary: Get predictions for a round
 *     parameters:
 *       - in: path
 *         name: roundId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of predictions
 */
router.get(
   '/round/:roundId',
   asyncHandler(async (req: Request, res: Response) => {
      const { roundId } = req.params;

      const predictions =
         await predictionService.getRoundPredictions(roundId);

      const serializedPredictions = predictions.map((p) =>
         serializePrediction({
            id: p.id,
            roundId: p.roundId,
            userId: p.userId,
            amount: p.amount,
            side: p.side,
            priceRange: p.priceRange,
            payout: p.payout,
            won: p.won,
            createdAt: p.createdAt?.toISOString?.() ?? p.createdAt,
            user: p.user
               ? {
                    id: p.user.id,
                    walletAddress: p.user.walletAddress,
                 }
               : null,
         }),
      );

      res.json({
         success: true,
         predictions: serializedPredictions,
      });
   })
);

export default router;
