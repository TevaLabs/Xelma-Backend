/**
 * Centralized application error taxonomy.
 *
 * All custom errors extend AppError so the global error handler can
 * identify them and map them to consistent HTTP responses.
 */

export enum ErrorCode {
  VALIDATION_ERROR = "VALIDATION_ERROR",
  AUTHENTICATION_ERROR = "AUTHENTICATION_ERROR",
  AUTHORIZATION_ERROR = "AUTHORIZATION_ERROR",
  NOT_FOUND = "NOT_FOUND",
  CONFLICT = "CONFLICT",
  BUSINESS_RULE_VIOLATION = "BUSINESS_RULE_VIOLATION",
  EXTERNAL_SERVICE_ERROR = "EXTERNAL_SERVICE_ERROR",
  CONFIGURATION_ERROR = "CONFIGURATION_ERROR",
  INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR",

  // Domain specific errors
  INVALID_CHALLENGE = "INVALID_CHALLENGE",
  CHALLENGE_EXPIRED = "CHALLENGE_EXPIRED",
  CHALLENGE_USED = "CHALLENGE_USED",
  INVALID_SIGNATURE = "INVALID_SIGNATURE",
  INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS",
  ROUND_NOT_ACTIVE = "ROUND_NOT_ACTIVE",
  ROUND_LOCKED = "ROUND_LOCKED",
  ROUND_ALREADY_RESOLVED = "ROUND_ALREADY_RESOLVED",
  DUPLICATE_PREDICTION = "DUPLICATE_PREDICTION",
  ACTIVE_ROUND_EXISTS = "ACTIVE_ROUND_EXISTS",
}

export interface ErrorDetail {
  field: string;
  message: string;
}

export class AppError extends Error {
  readonly statusCode: number;
  /** Machine-readable error code */
  readonly code: ErrorCode | string;
  readonly details?: ErrorDetail[];

  constructor(
    message: string,
    statusCode: number,
    code: ErrorCode | string,
    details?: ErrorDetail[],
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

/** 400 – request body / query / params failed schema validation */
export class ValidationError extends AppError {
  constructor(message: string, details?: ErrorDetail[]) {
    super(message, 400, ErrorCode.VALIDATION_ERROR, details);
  }
}

/** 401 – missing or invalid credentials */
export class AuthenticationError extends AppError {
  constructor(message: string, code: ErrorCode | string = ErrorCode.AUTHENTICATION_ERROR) {
    super(message, 401, code);
  }
}

/** 403 – authenticated but not permitted */
export class AuthorizationError extends AppError {
  constructor(message: string, code: ErrorCode | string = ErrorCode.AUTHORIZATION_ERROR) {
    super(message, 403, code);
  }
}

/** 404 – requested resource does not exist */
export class NotFoundError extends AppError {
  constructor(message: string, code: ErrorCode | string = ErrorCode.NOT_FOUND) {
    super(message, 404, code);
  }
}

/** 409 – request conflicts with current server state */
export class ConflictError extends AppError {
  constructor(message: string, code: ErrorCode | string = ErrorCode.CONFLICT) {
    super(message, 409, code);
  }
}

/** 422 – business-rule violation (request was well-formed but semantically invalid) */
export class BusinessRuleError extends AppError {
  constructor(message: string, code: ErrorCode | string = ErrorCode.BUSINESS_RULE_VIOLATION) {
    super(message, 422, code);
  }
}

/** 503 – upstream / external service failure */
export class ExternalServiceError extends AppError {
  constructor(message: string, code: ErrorCode | string = ErrorCode.EXTERNAL_SERVICE_ERROR) {
    super(message, 503, code);
  }
}

/** 500 – misconfiguration detected at runtime */
export class ConfigurationError extends AppError {
  constructor(message: string, code: ErrorCode | string = ErrorCode.CONFIGURATION_ERROR) {
    super(message, 500, code);
  }
}
