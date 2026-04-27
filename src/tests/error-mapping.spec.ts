import { describe, it, expect } from "@jest/globals";
import { 
  ErrorCode, 
  AppError, 
  ValidationError, 
  AuthenticationError, 
  NotFoundError, 
  BusinessRuleError 
} from "../utils/errors";

describe("Stable Error Codes (#149)", () => {
  it("should have correct code for ValidationError", () => {
    const error = new ValidationError("test");
    expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(error.statusCode).toBe(400);
  });

  it("should have correct code for AuthenticationError", () => {
    const error = new AuthenticationError("test");
    expect(error.code).toBe(ErrorCode.AUTHENTICATION_ERROR);
    expect(error.statusCode).toBe(401);
  });

  it("should allow custom domain code for AuthenticationError", () => {
    const error = new AuthenticationError("test", ErrorCode.INVALID_CHALLENGE);
    expect(error.code).toBe(ErrorCode.INVALID_CHALLENGE);
  });

  it("should have correct code for NotFoundError", () => {
    const error = new NotFoundError("test");
    expect(error.code).toBe(ErrorCode.NOT_FOUND);
    expect(error.statusCode).toBe(404);
  });

  it("should have correct code for BusinessRuleError", () => {
    const error = new BusinessRuleError("test", ErrorCode.ROUND_NOT_ACTIVE);
    expect(error.code).toBe(ErrorCode.ROUND_NOT_ACTIVE);
    expect(error.statusCode).toBe(422);
  });

  it("should preserve original message in AppError", () => {
    const msg = "Custom error message";
    const error = new AppError(msg, 500, ErrorCode.INTERNAL_SERVER_ERROR);
    expect(error.message).toBe(msg);
  });
});
