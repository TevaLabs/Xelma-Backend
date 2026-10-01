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
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               error: ValidationError
 *               message: amount must be a positive number
 *               code: VALIDATION_ERROR
 *               path: /api/predictions/submit
 *               requestId: c2b4e891-6f34-4b5a-9a8c-2f9e4d5c6b7a
 *               timestamp: '2026-09-28T12:00:00.000Z'
 *       401:
 *         description: Missing or invalid JWT
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnauthorizedResponse'
 *             example:
 *               error: AuthenticationError
 *               message: No token provided
 *               code: AUTHENTICATION_ERROR
 *               path: /api/predictions/submit
 *               requestId: c2b4e891-6f34-4b5a-9a8c-2f9e4d5c6b7a
 *               timestamp: '2026-09-28T12:00:00.000Z'
 *       403:
 *         description: Forbidden action
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ForbiddenResponse'
 *             example:
 *               error: ForbiddenError
 *               message: You do not have permission to place predictions
 *               code: FORBIDDEN
 *               path: /api/predictions/submit
 *               requestId: c2b4e891-6f34-4b5a-9a8c-2f9e4d5c6b7a
 *               timestamp: '2026-09-28T12:00:00.000Z'
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
 *               path: /api/predictions/submit
 *               requestId: c2b4e891-6f34-4b5a-9a8c-2f9e4d5c6b7a
 *               timestamp: '2026-09-28T12:00:00.000Z'
 *       429:
 *         description: Too many prediction submissions
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RateLimitResponse'
 *             example:
 *               error: Too Many Requests
 *               message: Too many requests from this IP. Please slow down and try again shortly.
 *               code: RATE_LIMIT_EXCEEDED
 *               path: /api/predictions/submit
 *               requestId: c2b4e891-6f34-4b5a-9a8c-2f9e4d5c6b7a
 *               timestamp: '2026-09-28T12:00:00.000Z'
 *               retryAfter: 60
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
 *         description: Predictions processed
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               error: ValidationError
 *               message: predictions array is required
 *               code: VALIDATION_ERROR
 *               path: /api/predictions/batch-submit
 *               requestId: c2b4e891-6f34-4b5a-9a8c-2f9e4d5c6b7a
 *               timestamp: '2026-09-28T12:00:00.000Z'
 *       401:
 *         description: Missing or invalid JWT
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnauthorizedResponse'
 *             example:
 *               error: AuthenticationError
 *               message: No token provided
 *               code: AUTHENTICATION_ERROR
 *               path: /api/predictions/batch-submit
 *               requestId: c2b4e891-6f34-4b5a-9a8c-2f9e4d5c6b7a
 *               timestamp: '2026-09-28T12:00:00.000Z'
 *       403:
 *         description: Forbidden action
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ForbiddenResponse'
 *             example:
 *               error: ForbiddenError
 *               message: You do not have permission to place predictions
 *               code: FORBIDDEN
 *               path: /api/predictions/batch-submit
 *               requestId: c2b4e891-6f34-4b5a-9a8c-2f9e4d5c6b7a
 *               timestamp: '2026-09-28T12:00:00.000Z'
 *       429:
 *         description: Too many batch requests
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RateLimitResponse'
 *             example:
 *               error: Too Many Requests
 *               message: Too many batch requests from this IP. Please wait before submitting again.
 *               code: RATE_LIMIT_EXCEEDED
 *               path: /api/predictions/batch-submit
 *               requestId: c2b4e891-6f34-4b5a-9a8c-2f9e4d5c6b7a
 *               timestamp: '2026-09-28T12:00:00.000Z'
 *               retryAfter: 60
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

      res.json({
         ...result,
         success: true,
      });
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
