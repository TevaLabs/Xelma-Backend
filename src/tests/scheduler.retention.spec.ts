import schedulerService from "../services/scheduler.service";
import retentionService from "../services/retention.service";
import logger from "../utils/logger";

// Mock dependencies
jest.mock("../services/retention.service");
jest.mock("../services/resolution.service");
jest.mock("../services/oracle");
jest.mock("../lib/prisma", () => ({
  prisma: {
    round: {
      findMany: jest.fn(),
    },
  },
}));
jest.mock("../utils/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

describe("SchedulerService - Retention Policies", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("runRetentionPolicies", () => {
    it("should execute all retention policies successfully", async () => {
      const mockResults = [
        {
          entity: "authChallenges",
          deletedCount: 10,
          cutoffDate: new Date(),
          executionTime: 50,
        },
        {
          entity: "chatMessages",
          deletedCount: 200,
          cutoffDate: new Date(),
          executionTime: 150,
        },
      ];

      (retentionService.runAllPolicies as jest.Mock).mockResolvedValue(mockResults);

      await schedulerService.runRetentionPolicies();

      expect(retentionService.runAllPolicies).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        "Starting scheduled retention policy execution",
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("authChallenges: 10 records deleted"),
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("chatMessages: 200 records deleted"),
      );
    });

    it("should handle zero deletions", async () => {
      const mockResults = [
        {
          entity: "authChallenges",
          deletedCount: 0,
          cutoffDate: new Date(),
          executionTime: 10,
        },
        {
          entity: "chatMessages",
          deletedCount: 0,
          cutoffDate: new Date(),
          executionTime: 15,
        },
      ];

      (retentionService.runAllPolicies as jest.Mock).mockResolvedValue(mockResults);

      await schedulerService.runRetentionPolicies();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("0 records deleted"),
      );
    });

    it("should handle errors gracefully", async () => {
      const mockError = new Error("Database connection failed");
      (retentionService.runAllPolicies as jest.Mock).mockRejectedValue(mockError);

      await schedulerService.runRetentionPolicies();

      expect(logger.error).toHaveBeenCalledWith(
        "Error in retention policy scheduler:",
        mockError,
      );
    });

    it("should log summary with multiple entities", async () => {
      const mockResults = [
        {
          entity: "authChallenges",
          deletedCount: 5,
          cutoffDate: new Date(),
          executionTime: 20,
        },
        {
          entity: "chatMessages",
          deletedCount: 150,
          cutoffDate: new Date(),
          executionTime: 100,
        },
      ];

      (retentionService.runAllPolicies as jest.Mock).mockResolvedValue(mockResults);

      await schedulerService.runRetentionPolicies();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringMatching(/authChallenges: 5 records deleted.*chatMessages: 150 records deleted/),
      );
    });

    it("should handle partial results", async () => {
      const mockResults = [
        {
          entity: "authChallenges",
          deletedCount: 3,
          cutoffDate: new Date(),
          executionTime: 15,
        },
      ];

      (retentionService.runAllPolicies as jest.Mock).mockResolvedValue(mockResults);

      await schedulerService.runRetentionPolicies();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("authChallenges: 3 records deleted"),
      );
    });
  });

  describe("Integration with scheduler", () => {
    it("should be callable as a scheduled task", async () => {
      const mockResults = [
        {
          entity: "authChallenges",
          deletedCount: 1,
          cutoffDate: new Date(),
          executionTime: 10,
        },
        {
          entity: "chatMessages",
          deletedCount: 50,
          cutoffDate: new Date(),
          executionTime: 30,
        },
      ];

      (retentionService.runAllPolicies as jest.Mock).mockResolvedValue(mockResults);

      // Simulate cron job execution
      await schedulerService.runRetentionPolicies();

      expect(retentionService.runAllPolicies).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        "Starting scheduled retention policy execution",
      );
    });
  });
});
