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
   checkIdempotency,
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
      try {
         const { roundId, amount, side, priceRange } = req.body;
         const userId = req.user.userId;
         const idempotencyKey = req.headers['idempotency-key'] as
            | string
            | undefined;

         // Validate idempotency key if provided
         if (idempotencyKey && !isValidIdempotencyKey(idempotencyKey)) {
            throw new ValidationError(
               'Invalid Idempotency-Key format. Must be 8-255 alphanumeric characters.'
            );
         }

         // Check for cached response from previous identical request
         if (idempotencyKey) {
            const idempotencyCheck = await checkIdempotency(
               userId,
               SUBMIT_PREDICTION_ENDPOINT,
               idempotencyKey,
               { roundId, amount, side, priceRange }
            );

            if (
               idempotencyCheck.isIdempotent &&
               idempotencyCheck.cachedResponse
            ) {
               // Return cached response
               return res
                  .status(idempotencyCheck.cachedResponse.status)
                  .json(idempotencyCheck.cachedResponse.body);
            }

            if (idempotencyCheck.error === IDEMPOTENCY_STORE_UNAVAILABLE) {
               throw new ExternalServiceError(
                  'Idempotency store unavailable. Please try again.',
                  ErrorCode.EXTERNAL_SERVICE_ERROR
               );
            }

            if (idempotencyCheck.error) {
               throw new ConflictError(
                  idempotencyCheck.error,
                  ErrorCode.IDEMPOTENCY_KEY_CONFLICT
               );
            }
         }

         const prediction = await predictionService.submitPrediction(
            userId,
            roundId,
            amount,
            side,
            priceRange
         );

         const responseBody = buildSubmitPredictionResponse(prediction);

         if (idempotencyKey) {
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
