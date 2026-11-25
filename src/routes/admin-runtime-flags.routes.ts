import { Router, Request, Response } from "express";
import { requireAdmin } from "../middleware/auth.middleware";
import config from "../config";
import { setNoStore } from "../utils/http-cache";

const router = Router();

/**
 * @openapi
 * /api/admin/runtime-flags:
 *   get:
 *     summary: Inspect safe runtime feature flags
 *     description: Returns the non-secret runtime flags for operators. Admin only.
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Safe runtime flag matrix
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 */
router.get("/", requireAdmin, (_req: Request, res: Response) => {
  setNoStore(res);
  res.json({
    success: true,
    flags: {
      dataMode: config.app.dataMode,
      dataStore: config.app.dataStore,
      roundsMockMode: config.app.roundsMockMode,
      enableSimulation: config.app.enableSimulation,
      enableMultiplayerSocial: config.app.enableMultiplayerSocial,
      socketDemoMode: config.app.socketDemoMode,
      safetyProfile: config.app.safetyProfile,
      autoResolveEnabled: config.scheduler.autoResolveEnabled,
      roundSchedulerEnabled: config.scheduler.roundSchedulerEnabled,
      roundSchedulerMode: config.scheduler.roundSchedulerMode,
    },
  });
});

export default router;
