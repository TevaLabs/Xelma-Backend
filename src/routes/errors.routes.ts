import { Router, Request, Response } from "express";

import { ERROR_CATALOG } from "../utils/errors";

const router = Router();

/**
 * @openapi
 * /errors:
 *   get:
 *     summary: Backend error code catalog (#196)
 *     description: |
 *       Returns the canonical list of error codes the API can emit, along
 *       with the HTTP status, the AppError subclass, and a short
 *       human-readable description for each. Use this to build client-side
 *       error-handling switches and to drive the public docs.
 *     tags:
 *       - Meta
 *     responses:
 *       200:
 *         description: Catalog of error codes
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 entries:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       code:
 *                         type: string
 *                       status:
 *                         type: integer
 *                       errorClass:
 *                         type: string
 *                       description:
 *                         type: string
 */
router.get("/", (_req: Request, res: Response) => {
  res.json({ entries: ERROR_CATALOG });
});

export default router;
