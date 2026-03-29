import { NextFunction, Request, Response, Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import { predictionRateLimiter } from "../middleware/rateLimiter.middleware";
import { validate } from "../middleware/validate.middleware";
import {
  batchSubmitPredictionsSchema,
  submitPredictionSchema,
} from "../schemas/predictions.schema";
import predictionService from "../services/prediction.service";

const router = Router();

/**
 * @swagger
 * /api/predictions/submit:
 *   post:
 *     summary: Submit a prediction for a round
 *     description: Authenticated users only.
 *     tags: [predictions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               roundId: { type: string }
 *               amount: { type: number, minimum: 0 }
 *               side: { type: string, description: UP/DOWN (for UP_DOWN mode)" }
 *               priceRange: { type: string, description: Price range selection (for LEGENDS mode)" }
 *             required: [roundId, amount]
 *           example:
 *             roundId: "round-id"
 *             amount: 10
 *             side: "UP"
 *     responses:
 *       200:
 *         description: Prediction submitted
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               prediction:
 *                 id: "prediction-id"
 *                 roundId: "round-id"
 *                 amount: 10
 *                 side: "UP"
 *                 priceRange: null
 *                 createdAt: "2026-01-29T00:00:00.000Z"
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             examples:
 *               missingRoundId:
 *                 value: { error: "Round ID is required" }
 *               invalidAmount:
 *                 value: { error: "Invalid amount" }
 *               missingSideOrRange:
 *                 value: { error: "Either side (UP/DOWN) or priceRange must be provided" }
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             example: { error: "No token provided" }
 *       429:
 *         description: Too many requests
 *         content:
 *           application/json:
 *             example: { error: "Too Many Requests", message: "Too many prediction submissions. Please wait before submitting another." }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             example: { error: "Failed to submit prediction" }
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X POST "$API_BASE_URL/api/predictions/submit" \\
 *             -H "Content-Type: application/json" \\
 *             -H "Authorization: Bearer $TOKEN" \\
 *             -d '{"roundId":"round-id","amount":10,"side":"UP"}'
 */
router.post(
  "/submit",
  authenticateUser,
  predictionRateLimiter,
  validate(submitPredictionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { roundId, amount, side, priceRange } = req.body;
      const userId = req.user!.userId;

      const prediction = await predictionService.submitPrediction(
        userId,
        roundId,
        amount,
        side,
        priceRange,
      );

      res.json({
        success: true,
        prediction: {
          id: prediction.id,
          roundId: prediction.roundId,
          amount: prediction.amount,
          side: prediction.side,
          priceRange: prediction.priceRange,
          createdAt: prediction.createdAt,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @swagger
 * /api/predictions/batch-submit:
 *   post:
 *     summary: Submit multiple predictions in a batch
 *     description: |
 *       Submit multiple predictions for different rounds in a single request.
 *       Each prediction is processed independently with transaction isolation.
 *       Partial success is supported - some predictions may succeed while others fail.
 *       Maximum 50 predictions per batch. Duplicate round IDs are not allowed.
 *     tags: [predictions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               predictions:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/SubmitPredictionRequest'
 *                 minItems: 1
 *                 maxItems: 50
 *             required: [predictions]
 *           example:
 *             predictions:
 *               - roundId: "round-id-1"
 *                 amount: 10
 *                 side: "UP"
 *               - roundId: "round-id-2"
 *                 amount: 15
 *                 side: "DOWN"
 *     responses:
 *       200:
 *         description: Batch prediction results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: true if at least one prediction succeeded
 *                 results:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/BatchPredictionResult'
 *             example:
 *               success: true
 *               results:
 *                 - index: 0
 *                   success: true
 *                   prediction:
 *                     id: "prediction-id-1"
 *                     roundId: "round-id-1"
 *                     amount: 10
 *                     side: "UP"
 *                     priceRange: null
 *                     createdAt: "2026-01-29T00:00:00.000Z"
 *                 - index: 1
 *                   success: false
 *                   error: "Round is not active"
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             examples:
 *               emptyBatch:
 *                 value: { error: "At least one prediction is required" }
 *               duplicateRounds:
 *                 value: { error: "Duplicate round IDs are not allowed in a batch" }
 *               tooManyPredictions:
 *                 value: { error: "Maximum 50 predictions per batch" }
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             example: { error: "No token provided" }
 *       429:
 *         description: Too many requests
 *         content:
 *           application/json:
 *             example: { error: "Too Many Requests", message: "Too many prediction submissions. Please wait before submitting another." }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             example: { error: "Failed to submit batch predictions" }
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X POST "$API_BASE_URL/api/predictions/batch-submit" \\
 *             -H "Content-Type: application/json" \\
 *             -H "Authorization: Bearer $TOKEN" \\
 *             -d '{"predictions":[{"roundId":"round-id-1","amount":10,"side":"UP"},{"roundId":"round-id-2","amount":15,"side":"DOWN"}]}'
 */
router.post(
  "/batch-submit",
  authenticateUser,
  predictionRateLimiter,
  validate(batchSubmitPredictionsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { predictions } = req.body;
      const userId = req.user!.userId;

      const result = await predictionService.submitBatchPredictions(
        userId,
        predictions,
      );

      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @swagger
 * /api/predictions/user/{userId}:
 *   get:
 *     summary: Get all predictions for a user
 *     tags: [predictions]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *         description: User ID
 *     responses:
 *       200:
 *         description: Predictions list
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               predictions: []
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             example: { error: "Failed to get user predictions" }
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X GET "$API_BASE_URL/api/predictions/user/user-id"
 */
router.get(
  "/user/:userId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.params;

      const predictions = await predictionService.getUserPredictions(userId);

      res.json({
        success: true,
        predictions,
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @swagger
 * /api/predictions/round/{roundId}:
 *   get:
 *     summary: Get all predictions for a round
 *     tags: [predictions]
 *     parameters:
 *       - in: path
 *         name: roundId
 *         required: true
 *         schema: { type: string }
 *         description: Round ID
 *     responses:
 *       200:
 *         description: Predictions list
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               predictions: []
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             example: { error: "Failed to get round predictions" }
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X GET "$API_BASE_URL/api/predictions/round/round-id"
 */
router.get(
  "/round/:roundId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { roundId } = req.params;

      const predictions = await predictionService.getRoundPredictions(roundId);

      res.json({
        success: true,
        predictions,
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
