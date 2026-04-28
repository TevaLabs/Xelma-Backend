import { prisma } from "../lib/prisma";
import logger from "../utils/logger";

interface RetentionPolicy {
  enabled: boolean;
  ttlDays: number;
  batchSize: number;
}

interface RetentionConfig {
  authChallenges: RetentionPolicy;
  chatMessages: RetentionPolicy;
}

interface RetentionResult {
  entity: string;
  deletedCount: number;
  cutoffDate: Date;
  executionTime: number;
}

class RetentionService {
  private config: RetentionConfig;

  constructor() {
    // Load configuration from environment variables with defaults
    this.config = {
      authChallenges: {
        enabled: process.env.RETENTION_AUTH_CHALLENGES_ENABLED !== "false",
        ttlDays: parseInt(process.env.RETENTION_AUTH_CHALLENGES_TTL_DAYS || "7", 10),
        batchSize: parseInt(process.env.RETENTION_BATCH_SIZE || "1000", 10),
      },
      chatMessages: {
        enabled: process.env.RETENTION_CHAT_MESSAGES_ENABLED !== "false",
        ttlDays: parseInt(process.env.RETENTION_CHAT_MESSAGES_TTL_DAYS || "90", 10),
        batchSize: parseInt(process.env.RETENTION_BATCH_SIZE || "1000", 10),
      },
    };
  }

  /**
   * Get current retention configuration
   */
  getConfig(): RetentionConfig {
    return { ...this.config };
  }

  /**
   * Clean up expired auth challenges
   */
  async cleanupAuthChallenges(): Promise<RetentionResult> {
    const startTime = Date.now();
    const policy = this.config.authChallenges;

    if (!policy.enabled) {
      logger.info("Auth challenges retention policy is disabled");
      return {
        entity: "authChallenges",
        deletedCount: 0,
        cutoffDate: new Date(),
        executionTime: 0,
      };
    }

    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - policy.ttlDays);

      logger.info(
        `Starting auth challenges cleanup (TTL: ${policy.ttlDays} days, cutoff: ${cutoffDate.toISOString()})`,
      );

      // Delete expired challenges (both by expiresAt and by createdAt for safety)
      const result = await prisma.authChallenge.deleteMany({
        where: {
          OR: [
            {
              expiresAt: {
                lt: new Date(), // Already expired by design
              },
            },
            {
              createdAt: {
                lt: cutoffDate, // Older than retention period
              },
            },
          ],
        },
      });

      const executionTime = Date.now() - startTime;

      logger.info(
        `Auth challenges cleanup completed: Deleted ${result.count} records in ${executionTime}ms`,
      );

      return {
        entity: "authChallenges",
        deletedCount: result.count,
        cutoffDate,
        executionTime,
      };
    } catch (error) {
      logger.error("Failed to cleanup auth challenges:", error);
      throw error;
    }
  }

  /**
   * Clean up old chat messages
   */
  async cleanupChatMessages(): Promise<RetentionResult> {
    const startTime = Date.now();
    const policy = this.config.chatMessages;

    if (!policy.enabled) {
      logger.info("Chat messages retention policy is disabled");
      return {
        entity: "chatMessages",
        deletedCount: 0,
        cutoffDate: new Date(),
        executionTime: 0,
      };
    }

    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - policy.ttlDays);

      logger.info(
        `Starting chat messages cleanup (TTL: ${policy.ttlDays} days, cutoff: ${cutoffDate.toISOString()})`,
      );

      const result = await prisma.message.deleteMany({
        where: {
          createdAt: {
            lt: cutoffDate,
          },
        },
      });

      const executionTime = Date.now() - startTime;

      logger.info(
        `Chat messages cleanup completed: Deleted ${result.count} records in ${executionTime}ms`,
      );

      return {
        entity: "chatMessages",
        deletedCount: result.count,
        cutoffDate,
        executionTime,
      };
    } catch (error) {
      logger.error("Failed to cleanup chat messages:", error);
      throw error;
    }
  }

  /**
   * Run all retention policies
   */
  async runAllPolicies(): Promise<RetentionResult[]> {
    logger.info("Starting retention policy execution for all entities");

    const results: RetentionResult[] = [];

    try {
      // Run auth challenges cleanup
      const authResult = await this.cleanupAuthChallenges();
      results.push(authResult);

      // Run chat messages cleanup
      const chatResult = await this.cleanupChatMessages();
      results.push(chatResult);

      const totalDeleted = results.reduce((sum, r) => sum + r.deletedCount, 0);
      const totalTime = results.reduce((sum, r) => sum + r.executionTime, 0);

      logger.info(
        `Retention policy execution completed: ${totalDeleted} total records deleted in ${totalTime}ms`,
      );

      return results;
    } catch (error) {
      logger.error("Error during retention policy execution:", error);
      throw error;
    }
  }

  /**
   * Get count of records that would be deleted (dry run)
   */
  async getDeletionPreview(): Promise<{
    authChallenges: { count: number; cutoffDate: Date };
    chatMessages: { count: number; cutoffDate: Date };
  }> {
    try {
      const authCutoff = new Date();
      authCutoff.setDate(authCutoff.getDate() - this.config.authChallenges.ttlDays);

      const chatCutoff = new Date();
      chatCutoff.setDate(chatCutoff.getDate() - this.config.chatMessages.ttlDays);

      const [authCount, chatCount] = await Promise.all([
        prisma.authChallenge.count({
          where: {
            OR: [
              { expiresAt: { lt: new Date() } },
              { createdAt: { lt: authCutoff } },
            ],
          },
        }),
        prisma.message.count({
          where: {
            createdAt: { lt: chatCutoff },
          },
        }),
      ]);

      return {
        authChallenges: {
          count: authCount,
          cutoffDate: authCutoff,
        },
        chatMessages: {
          count: chatCount,
          cutoffDate: chatCutoff,
        },
      };
    } catch (error) {
      logger.error("Failed to get deletion preview:", error);
      throw error;
    }
  }

  /**
   * Validate retention configuration
   */
  validateConfig(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (this.config.authChallenges.ttlDays < 1) {
      errors.push("Auth challenges TTL must be at least 1 day");
    }

    if (this.config.chatMessages.ttlDays < 1) {
      errors.push("Chat messages TTL must be at least 1 day");
    }

    if (this.config.authChallenges.batchSize < 1) {
      errors.push("Batch size must be at least 1");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

export default new RetentionService();
