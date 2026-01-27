import { PrismaClient } from "@prisma/client";
import logger from "../utils/logger";

const prisma = new PrismaClient();

interface NotificationPreferences {
  win?: boolean;
  loss?: boolean;
  roundStart?: boolean;
  bonus?: boolean;
  announcement?: boolean;
}

interface CreateNotificationInput {
  userId: string;
  type: "WIN" | "LOSS" | "ROUND_START" | "BONUS_AVAILABLE" | "ANNOUNCEMENT";
  title: string;
  message: string;
  data?: any;
}

interface PaginatedResponse {
  notifications: any[];
  total: number;
  limit: number;
  offset: number;
}

class NotificationService {
  /**
   * Check if a notification type should be sent based on user preferences
   */
  private async checkPreference(
    userId: string,
    type: "WIN" | "LOSS" | "ROUND_START" | "BONUS_AVAILABLE" | "ANNOUNCEMENT",
  ): Promise<boolean> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { notificationPreferences: true },
      });

      if (!user || !user.notificationPreferences) {
        return true; // Default to true if no preferences set
      }

      const prefs = user.notificationPreferences as NotificationPreferences;

      switch (type) {
        case "WIN":
          return prefs.win !== false;
        case "LOSS":
          return prefs.loss !== false;
        case "ROUND_START":
          return prefs.roundStart !== false;
        case "BONUS_AVAILABLE":
          return prefs.bonus !== false;
        case "ANNOUNCEMENT":
          return prefs.announcement !== false;
        default:
          return true;
      }
    } catch (error) {
      logger.error("Error checking notification preference:", error);
      return true; // Default to true on error
    }
  }

  /**
  /**
   * Create a new notification
   */
  async createNotification(
    input: CreateNotificationInput,
  ): Promise<any | null> {
    try {
      // Check user preferences first
      const shouldNotify = await this.checkPreference(input.userId, input.type);
      if (!shouldNotify) {
        logger.info(
          `Notification skipped for user ${input.userId} due to preference (type: ${input.type})`,
        );
        return null;
      }

      const notification = await prisma.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          title: input.title,
          message: input.message,
          data: input.data || null,
        },
      });

      logger.info(
        `Created notification ${notification.id} for user ${input.userId}`,
      );
      return notification;
    } catch (error) {
      logger.error("Failed to create notification:", error);
      throw error;
    }
  }

  /**
   * Get paginated notifications for a user
   */
  async getUserNotifications(
    userId: string,
    limit: number = 20,
    offset: number = 0,
    unreadOnly: boolean = false,
  ): Promise<PaginatedResponse> {
    try {
      // Ensure limit doesn't exceed max
      const finalLimit = Math.min(limit, 100);

      const where = unreadOnly ? { userId, isRead: false } : { userId };

      const [notifications, total] = await Promise.all([
        prisma.notification.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: offset,
          take: finalLimit,
        }),
        prisma.notification.count({ where }),
      ]);

      return {
        notifications,
        total,
        limit: finalLimit,
        offset,
      };
    } catch (error) {
      logger.error("Failed to fetch user notifications:", error);
      throw error;
    }
  }

  /**
   * Mark a notification as read
   */
  async markAsRead(
    notificationId: string,
    userId: string,
  ): Promise<any | null> {
    try {
      // Verify ownership before updating
      const notification = await prisma.notification.findUnique({
        where: { id: notificationId },
      });

      if (!notification) {
        logger.warn(`Notification ${notificationId} not found`);
        return null;
      }

      if (notification.userId !== userId) {
        logger.warn(
          `User ${userId} attempted to update notification belonging to ${notification.userId}`,
        );
        return null;
      }

      const updated = await prisma.notification.update({
        where: { id: notificationId },
        data: { isRead: true },
      });

      logger.info(`Marked notification ${notificationId} as read`);
      return updated;
    } catch (error) {
      logger.error("Failed to mark notification as read:", error);
      throw error;
    }
  }

  /**
   * Mark all notifications as read for a user
   */
  async markAllAsRead(userId: string): Promise<number> {
    try {
      const result = await prisma.notification.updateMany({
        where: { userId, isRead: false },
        data: { isRead: true },
      });

      logger.info(
        `Marked ${result.count} notifications as read for user ${userId}`,
      );
      return result.count;
    } catch (error) {
      logger.error("Failed to mark all notifications as read:", error);
      throw error;
    }
  }

  /**
   * Delete a single notification
   */
  async deleteNotification(
    notificationId: string,
    userId: string,
  ): Promise<boolean> {
    try {
      // Verify ownership before deleting
      const notification = await prisma.notification.findUnique({
        where: { id: notificationId },
      });

      if (!notification) {
        logger.warn(`Notification ${notificationId} not found`);
        return false;
      }

      if (notification.userId !== userId) {
        logger.warn(
          `User ${userId} attempted to delete notification belonging to ${notification.userId}`,
        );
        return false;
      }

      await prisma.notification.delete({
        where: { id: notificationId },
      });

      logger.info(`Deleted notification ${notificationId}`);
      return true;
    } catch (error) {
      logger.error("Failed to delete notification:", error);
      throw error;
    }
  }

  /**
   * Delete all read notifications for a user
   */
  async deleteAllRead(userId: string): Promise<number> {
    try {
      const result = await prisma.notification.deleteMany({
        where: { userId, isRead: true },
      });

      logger.info(
        `Deleted ${result.count} read notifications for user ${userId}`,
      );
      return result.count;
    } catch (error) {
      logger.error("Failed to delete read notifications:", error);
      throw error;
    }
  }

  /**
   * Delete notifications older than specified days
   * (Called by cron job)
   */
  async cleanupOldNotifications(daysOld: number = 30): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);

      const result = await prisma.notification.deleteMany({
        where: {
          createdAt: {
            lt: cutoffDate,
          },
        },
      });

      logger.info(
        `Cleanup: Deleted ${result.count} notifications older than ${daysOld} days`,
      );
      return result.count;
    } catch (error) {
      logger.error("Failed to cleanup old notifications:", error);
      throw error;
    }
  }

  /**
   * Get a single notification (for verification)
   */
  async getNotification(
    notificationId: string,
    userId: string,
  ): Promise<any | null> {
    try {
      const notification = await prisma.notification.findUnique({
        where: { id: notificationId },
      });

      if (!notification) {
        return null;
      }

      // Verify ownership
      if (notification.userId !== userId) {
        logger.warn(
          `User ${userId} attempted to access notification belonging to ${notification.userId}`,
        );
        return null;
      }

      return notification;
    } catch (error) {
      logger.error("Failed to fetch notification:", error);
      throw error;
    }
  }

  /**
   * Get unread count for a user
   */
  async getUnreadCount(userId: string): Promise<number> {
    try {
      const count = await prisma.notification.count({
        where: { userId, isRead: false },
      });

      return count;
    } catch (error) {
      logger.error("Failed to get unread count:", error);
      throw error;
    }
  }
}

export default new NotificationService();
