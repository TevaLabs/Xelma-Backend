import { Router, Response, NextFunction } from "express";
import notificationService from "../services/notification.service";
import { authenticateUser, AuthenticatedRequest } from "../middleware/auth.middleware";
import { NotFoundError } from "../utils/errors";
import { validate } from "../middleware/validate.middleware";
import { z } from "zod";
import { unifiedPaginationSchema } from "../schemas/pagination.schema";

const router = Router();

/**
 * Extend the unified pagination schema with the notifications-specific
 * `unreadOnly` filter.
 */
const notificationsQuerySchema = unifiedPaginationSchema.extend({
  unreadOnly: z
    .preprocess((v) => v === "true" || v === true, z.boolean())
    .optional()
    .default(false),
});

/**
 * @openapi
 * /api/notifications:
 *   get:
 *     tags: [Notifications]
 *     summary: Get paginated notifications
 *     description: |
 *       Returns notifications for the authenticated user. Supports two pagination modes:
 *
 *       **Cursor mode** (recommended): pass `cursor` from a previous response's
 *       `pagination.nextCursor` to load the next (older) page.
 *
 *       **Offset mode**: pass `offset` to skip rows. Backward-compatible with
 *       existing clients.
 *
 *       When `cursor` is present, `offset` is ignored.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *         description: Opaque cursor from pagination.nextCursor (cursor mode)
 *       - in: query
 *         name: offset
 *         schema: { type: integer, minimum: 0, default: 0 }
 *         description: Rows to skip (offset mode, ignored when cursor is present)
 *       - in: query
 *         name: unreadOnly
 *         schema: { type: boolean, default: false }
 *         description: When true, only unread notifications are returned
 *     responses:
 *       200:
 *         description: Notifications page
 *       401:
 *         description: Unauthorized
 *       400:
 *         description: Validation error
 */
router.get(
  "/",
  authenticateUser,
  validate(notificationsQuerySchema, "query"),
  (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user.userId;
      const { limit, offset, cursor, unreadOnly } = req.query as unknown as {
        limit: number;
        offset: number;
        cursor?: string;
        unreadOnly: boolean;
      };

      if (cursor) {
        // Cursor mode
        const result = await notificationService.getUserNotificationsCursor(
          userId,
          limit,
          cursor,
          unreadOnly,
        );
        return res.json({
          success: true,
          notifications: result.data,
          pagination: result.pagination,
        });
      }

      // Offset mode
      const result = await notificationService.getUserNotificationsOffset(
        userId,
        limit,
        offset,
        unreadOnly,
      );
      return res.json({
        success: true,
        notifications: result.data,
        pagination: result.pagination,
        // Legacy fields kept for backward compatibility
        total: result.pagination.total,
        limit: result.pagination.limit,
        offset: result.pagination.offset,
      });
    } catch (error) {
      next(error);
    }
  }) as any,
);

/**
 * GET /api/notifications/unread-count
 * Get the count of unread notifications for the authenticated user
 */
router.get(
  "/unread-count",
  authenticateUser,
  (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user.userId;
      const count = await notificationService.getUnreadCount(userId);
      res.json({ success: true, unreadCount: count });
    } catch (error) {
      next(error);
    }
  }) as any,
);

/**
 * GET /api/notifications/:id
 * Get a specific notification
 */
router.get("/:id", authenticateUser, (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const notification = await notificationService.getNotification(id, userId);

    if (!notification) {
      return next(new NotFoundError("Notification not found"));
    }

    res.json({
      success: true,
      notification: {
        id: notification.id,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        data: notification.data,
        isRead: notification.isRead,
        createdAt: notification.createdAt.toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
}) as any);

/**
 * PATCH /api/notifications/:id/read
 * Mark a single notification as read
 */
router.patch(
  "/:id/read",
  authenticateUser,
  (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user.userId;
      const { id } = req.params;

      const notification = await notificationService.markAsRead(id, userId);

      if (!notification) {
        return next(new NotFoundError("Notification not found or access denied"));
      }

      res.json({
        success: true,
        message: "Notification marked as read",
        notification: {
          id: notification.id,
          isRead: notification.isRead,
        },
      });
    } catch (error) {
      next(error);
    }
  }) as any,
);

/**
 * PATCH /api/notifications/read-all
 * Mark all unread notifications as read for the authenticated user
 */
router.patch(
  "/read-all",
  authenticateUser,
  (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user.userId;
      const count = await notificationService.markAllAsRead(userId);
      res.json({
        success: true,
        message: `Marked ${count} notification(s) as read`,
        markedCount: count,
      });
    } catch (error) {
      next(error);
    }
  }) as any,
);

/**
 * DELETE /api/notifications/:id
 * Delete a single notification
 */
router.delete("/:id", authenticateUser, (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const deleted = await notificationService.deleteNotification(id, userId);

    if (!deleted) {
      return next(new NotFoundError("Notification not found or access denied"));
    }

    res.json({ success: true, message: "Notification deleted" });
  } catch (error) {
    next(error);
  }
}) as any);

/**
 * DELETE /api/notifications
 * Delete all read notifications for the authenticated user
 */
router.delete("/", authenticateUser, (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user.userId;
    const count = await notificationService.deleteAllRead(userId);
    res.json({
      success: true,
      message: `Deleted ${count} read notification(s)`,
      deletedCount: count,
    });
  } catch (error) {
    next(error);
  }
}) as any);

export default router;
