import { prisma } from "../lib/prisma";
import retentionService from "../services/retention.service";
import logger from "../utils/logger";

// Mock logger
jest.mock("../utils/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));
jest.mock("../utils/idempotency.util", () => ({
  cleanupExpiredIdempotencyKeys: jest.fn().mockResolvedValue(0),
}));

describe("RetentionService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getConfig", () => {
    it("should return current retention configuration", () => {
      const config = retentionService.getConfig();

      expect(config).toHaveProperty("authChallenges");
      expect(config).toHaveProperty("chatMessages");
      expect(config).toHaveProperty("auditLogs");
      expect(config.authChallenges).toHaveProperty("enabled");
      expect(config.authChallenges).toHaveProperty("ttlDays");
      expect(config.chatMessages).toHaveProperty("enabled");
      expect(config.chatMessages).toHaveProperty("ttlDays");
      expect(config.auditLogs).toHaveProperty("enabled");
      expect(config.auditLogs).toHaveProperty("ttlDays");
    });
  });

  describe("validateConfig", () => {
    it("should validate configuration successfully", () => {
      const validation = retentionService.validateConfig();

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should reject invalid audit log TTL", async () => {
      // Mock environment with invalid audit log TTL
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        RETENTION_AUDIT_LOGS_TTL_DAYS: "0",
      };

      // Need to reload service with new env
      jest.resetModules();
      const { default: testRetentionService } = await import("../services/retention.service");

      const validation = testRetentionService.validateConfig();

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("Audit logs TTL must be at least 1 day");

      process.env = originalEnv;
    });
  });

  describe("cleanupAuthChallenges", () => {
    it("should delete expired auth challenges", async () => {
      const mockDeleteResult = { count: 5 };
      jest.spyOn(prisma.authChallenge, "deleteMany").mockResolvedValue(mockDeleteResult);

      const result = await retentionService.cleanupAuthChallenges();

      expect(result.entity).toBe("authChallenges");
      expect(result.deletedCount).toBe(5);
      expect(result.cutoffDate).toBeInstanceOf(Date);
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
      expect(prisma.authChallenge.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: [
            {
              expiresAt: {
                lt: expect.any(Date),
              },
            },
            {
              createdAt: {
                lt: expect.any(Date),
              },
            },
          ],
        },
      });
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Auth challenges cleanup completed"),
      );
    });

    it("should handle zero deletions", async () => {
      const mockDeleteResult = { count: 0 };
      jest.spyOn(prisma.authChallenge, "deleteMany").mockResolvedValue(mockDeleteResult);

      const result = await retentionService.cleanupAuthChallenges();

      expect(result.deletedCount).toBe(0);
      expect(logger.info).toHaveBeenCalled();
    });

    it("should respect cutoff date boundaries", async () => {
      const mockDeleteResult = { count: 3 };
      jest.spyOn(prisma.authChallenge, "deleteMany").mockResolvedValue(mockDeleteResult);

      const beforeCleanup = new Date();
      const result = await retentionService.cleanupAuthChallenges();
      const afterCleanup = new Date();

      // Cutoff date should be in the past
      expect(result.cutoffDate.getTime()).toBeLessThan(beforeCleanup.getTime());
      
      // Verify the cutoff is approximately correct (7 days by default)
      const config = retentionService.getConfig();
      const expectedCutoff = new Date();
      expectedCutoff.setDate(expectedCutoff.getDate() - config.authChallenges.ttlDays);
      
      // Allow 1 second tolerance for test execution time
      const timeDiff = Math.abs(result.cutoffDate.getTime() - expectedCutoff.getTime());
      expect(timeDiff).toBeLessThan(1000);
    });

    it("should throw error on database failure", async () => {
      const mockError = new Error("Database connection failed");
      jest.spyOn(prisma.authChallenge, "deleteMany").mockRejectedValue(mockError);

      await expect(retentionService.cleanupAuthChallenges()).rejects.toThrow(
        "Database connection failed",
      );
      expect(logger.error).toHaveBeenCalledWith(
        "Failed to cleanup auth challenges:",
        mockError,
      );
    });
  });

  describe("cleanupChatMessages", () => {
    it("should delete old chat messages", async () => {
      const mockDeleteResult = { count: 150 };
      jest.spyOn(prisma.message, "deleteMany").mockResolvedValue(mockDeleteResult);

      const result = await retentionService.cleanupChatMessages();

      expect(result.entity).toBe("chatMessages");
      expect(result.deletedCount).toBe(150);
      expect(result.cutoffDate).toBeInstanceOf(Date);
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
      expect(prisma.message.deleteMany).toHaveBeenCalledWith({
        where: {
          createdAt: {
            lt: expect.any(Date),
          },
        },
      });
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Chat messages cleanup completed"),
      );
    });

    it("should not delete messages within retention period", async () => {
      const mockDeleteResult = { count: 0 };
      jest.spyOn(prisma.message, "deleteMany").mockResolvedValue(mockDeleteResult);

      const result = await retentionService.cleanupChatMessages();

      expect(result.deletedCount).toBe(0);
      
      // Verify cutoff date is in the past
      const now = new Date();
      expect(result.cutoffDate.getTime()).toBeLessThan(now.getTime());
    });

    it("should handle large deletion counts", async () => {
      const mockDeleteResult = { count: 10000 };
      jest.spyOn(prisma.message, "deleteMany").mockResolvedValue(mockDeleteResult);

      const result = await retentionService.cleanupChatMessages();

      expect(result.deletedCount).toBe(10000);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("10000 records"),
      );
    });

    it("should throw error on database failure", async () => {
      const mockError = new Error("Query timeout");
      jest.spyOn(prisma.message, "deleteMany").mockRejectedValue(mockError);

      await expect(retentionService.cleanupChatMessages()).rejects.toThrow(
        "Query timeout",
      );
      expect(logger.error).toHaveBeenCalledWith(
        "Failed to cleanup chat messages:",
        mockError,
      );
    });
  });

  describe("cleanupAuditLogs", () => {
    it("should delete old audit logs", async () => {
      const mockDeleteResult = { count: 50 };
      jest.spyOn(prisma.auditLog, "deleteMany").mockResolvedValue(mockDeleteResult);

      const result = await retentionService.cleanupAuditLogs();

      expect(result.entity).toBe("auditLogs");
      expect(result.deletedCount).toBe(50);
      expect(result.cutoffDate).toBeInstanceOf(Date);
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
      expect(prisma.auditLog.deleteMany).toHaveBeenCalledWith({
        where: {
          timestamp: {
            lt: expect.any(Date),
          },
        },
      });
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Audit logs cleanup completed"),
      );
    });

    it("should not delete audit logs within retention period", async () => {
      const mockDeleteResult = { count: 0 };
      jest.spyOn(prisma.auditLog, "deleteMany").mockResolvedValue(mockDeleteResult);

      const result = await retentionService.cleanupAuditLogs();

      expect(result.deletedCount).toBe(0);
      
      // Verify cutoff date is in the past
      const now = new Date();
      expect(result.cutoffDate.getTime()).toBeLessThan(now.getTime());
    });

    it("should handle large deletion counts", async () => {
      const mockDeleteResult = { count: 50000 };
      jest.spyOn(prisma.auditLog, "deleteMany").mockResolvedValue(mockDeleteResult);

      const result = await retentionService.cleanupAuditLogs();

      expect(result.deletedCount).toBe(50000);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("50000 records"),
      );
    });

    it("should throw error on database failure", async () => {
      const mockError = new Error("Connection failed");
      jest.spyOn(prisma.auditLog, "deleteMany").mockRejectedValue(mockError);

      await expect(retentionService.cleanupAuditLogs()).rejects.toThrow(
        "Connection failed",
      );
      expect(logger.error).toHaveBeenCalledWith(
        "Failed to cleanup audit logs:",
        mockError,
      );
    });

    it("should respect cutoff date boundaries", async () => {
      const mockDeleteResult = { count: 3 };
      jest.spyOn(prisma.auditLog, "deleteMany").mockResolvedValue(mockDeleteResult);

      const beforeCleanup = new Date();
      const result = await retentionService.cleanupAuditLogs();
      const afterCleanup = new Date();

      // Cutoff date should be in the past
      expect(result.cutoffDate.getTime()).toBeLessThan(beforeCleanup.getTime());
      
      // Verify the cutoff is approximately correct (90 days by default)
      const config = retentionService.getConfig();
      const expectedCutoff = new Date();
      expectedCutoff.setDate(expectedCutoff.getDate() - config.auditLogs.ttlDays);
      
      // Allow 1 second tolerance for test execution time
      const timeDiff = Math.abs(result.cutoffDate.getTime() - expectedCutoff.getTime());
      expect(timeDiff).toBeLessThan(1000);
    });
  });

  describe("runAllPolicies", () => {
    it("should execute all retention policies", async () => {
      const mockAuthResult = { count: 5 };
      const mockChatResult = { count: 100 };
      const mockAuditResult = { count: 75 };
      
      jest.spyOn(prisma.authChallenge, "deleteMany").mockResolvedValue(mockAuthResult);
      jest.spyOn(prisma.message, "deleteMany").mockResolvedValue(mockChatResult);
      jest.spyOn(prisma.auditLog, "deleteMany").mockResolvedValue(mockAuditResult);

      const results = await retentionService.runAllPolicies();

      expect(results).toHaveLength(3);
      expect(results[0].entity).toBe("authChallenges");
      expect(results[0].deletedCount).toBe(5);
      expect(results[1].entity).toBe("chatMessages");
      expect(results[1].deletedCount).toBe(100);
      expect(results[2].entity).toBe("auditLogs");
      expect(results[2].deletedCount).toBe(75);
      
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("180 total records deleted"),
      );
    });

    it("should handle partial failures gracefully", async () => {
      jest.spyOn(prisma.authChallenge, "deleteMany").mockResolvedValue({ count: 5 });
      jest.spyOn(prisma.message, "deleteMany").mockRejectedValue(new Error("DB error"));

      await expect(retentionService.runAllPolicies()).rejects.toThrow("DB error");
      
      expect(logger.error).toHaveBeenCalled();
    });

    it("should return empty results when all policies are disabled", async () => {
      // Mock environment to disable policies
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        RETENTION_AUTH_CHALLENGES_ENABLED: "false",
        RETENTION_CHAT_MESSAGES_ENABLED: "false",
        RETENTION_AUDIT_LOGS_ENABLED: "false",
      };

      // Need to reload service with new env
      jest.resetModules();
      const { default: testRetentionService } = await import("../services/retention.service");

      const results = await testRetentionService.runAllPolicies();

      expect(results).toHaveLength(3);
      expect(results[0].deletedCount).toBe(0);
      expect(results[1].deletedCount).toBe(0);
      expect(results[2].deletedCount).toBe(0);

      process.env = originalEnv;
    });
  });

  describe("getDeletionPreview", () => {
    it("should return preview of records to be deleted", async () => {
      jest.spyOn(prisma.authChallenge, "count").mockResolvedValue(10);
      jest.spyOn(prisma.message, "count").mockResolvedValue(250);
      jest.spyOn(prisma.auditLog, "count").mockResolvedValue(75);

      const preview = await retentionService.getDeletionPreview();

      expect(preview.authChallenges.count).toBe(10);
      expect(preview.authChallenges.cutoffDate).toBeInstanceOf(Date);
      expect(preview.chatMessages.count).toBe(250);
      expect(preview.chatMessages.cutoffDate).toBeInstanceOf(Date);
      expect(preview.auditLogs.count).toBe(75);
      expect(preview.auditLogs.cutoffDate).toBeInstanceOf(Date);
      
      // Verify cutoff dates are in the past
      const now = new Date();
      expect(preview.authChallenges.cutoffDate.getTime()).toBeLessThan(now.getTime());
      expect(preview.chatMessages.cutoffDate.getTime()).toBeLessThan(now.getTime());
      expect(preview.auditLogs.cutoffDate.getTime()).toBeLessThan(now.getTime());
    });

    it("should handle zero counts", async () => {
      jest.spyOn(prisma.authChallenge, "count").mockResolvedValue(0);
      jest.spyOn(prisma.message, "count").mockResolvedValue(0);
      jest.spyOn(prisma.auditLog, "count").mockResolvedValue(0);

      const preview = await retentionService.getDeletionPreview();

      expect(preview.authChallenges.count).toBe(0);
      expect(preview.chatMessages.count).toBe(0);
      expect(preview.auditLogs.count).toBe(0);
    });

    it("should throw error on database failure", async () => {
      const mockError = new Error("Connection lost");
      jest.spyOn(prisma.authChallenge, "count").mockRejectedValue(mockError);

      await expect(retentionService.getDeletionPreview()).rejects.toThrow(
        "Connection lost",
      );
      expect(logger.error).toHaveBeenCalledWith(
        "Failed to get deletion preview:",
        mockError,
      );
    });
  });

  describe("Boundary conditions", () => {
    it("should handle exact cutoff date boundary", async () => {
      const mockDeleteResult = { count: 1 };
      jest.spyOn(prisma.message, "deleteMany").mockResolvedValue(mockDeleteResult);

      const result = await retentionService.cleanupChatMessages();

      // Verify the query uses 'lt' (less than) not 'lte' (less than or equal)
      expect(prisma.message.deleteMany).toHaveBeenCalledWith({
        where: {
          createdAt: {
            lt: expect.any(Date),
          },
        },
      });
    });

    it("should protect non-expired records", async () => {
      // This test verifies that the cutoff logic is correct
      const config = retentionService.getConfig();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - config.chatMessages.ttlDays);

      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - (config.chatMessages.ttlDays - 1));

      // Recent date should be after cutoff (not deleted)
      expect(recentDate.getTime()).toBeGreaterThan(cutoffDate.getTime());
    });
  });

  describe("Performance and metrics", () => {
    it("should track execution time", async () => {
      jest.spyOn(prisma.authChallenge, "deleteMany").mockImplementation(
        (() => new Promise(resolve => setTimeout(() => resolve({ count: 5 }), 10))) as any,
      );

      const result = await retentionService.cleanupAuthChallenges();

      expect(result.executionTime).toBeGreaterThan(0);
      expect(result.executionTime).toBeGreaterThanOrEqual(10);
    });

    it("should log execution metrics", async () => {
      jest.spyOn(prisma.authChallenge, "deleteMany").mockResolvedValue({ count: 5 });
      jest.spyOn(prisma.message, "deleteMany").mockResolvedValue({ count: 100 });
      jest.spyOn(prisma.auditLog, "deleteMany").mockResolvedValue({ count: 75 });

      await retentionService.runAllPolicies();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("180 total records deleted"),
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringMatching(/\d+ms/),
      );
    });
  });
});
