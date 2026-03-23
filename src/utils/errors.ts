/**
 * Centralized application error taxonomy.
 *
 * All custom errors extend AppError so the global error handler can
 * identify them and map them to consistent HTTP responses.
 */

export interface ErrorDetail {
  field: string;
  message: string;
}

export class AppError extends Error {
  readonly statusCode: number;
  /** Machine-readable error code (e.g. "ACTIVE_ROUND_EXISTS") */
  readonly code: string;
  readonly details?: ErrorDetail[];

  constructor(
    message: string,
    statusCode: number,
    code: string,
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
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

/** 401 – missing or invalid credentials */
export class AuthenticationError extends AppError {
  constructor(message: string, code = 'AUTHENTICATION_ERROR') {
    super(message, 401, code);
  }
}

/** 403 – authenticated but not permitted */
export class AuthorizationError extends AppError {
  constructor(message: string, code = 'AUTHORIZATION_ERROR') {
    super(message, 403, code);
  }
}

/** 404 – requested resource does not exist */
export class NotFoundError extends AppError {
  constructor(message: string, code = 'NOT_FOUND') {
    super(message, 404, code);
  }
}

/** 409 – request conflicts with current server state */
export class ConflictError extends AppError {
  constructor(message: string, code = 'CONFLICT') {
    super(message, 409, code);
  }
}

/** 422 – business-rule violation (request was well-formed but semantically invalid) */
export class BusinessRuleError extends AppError {
  constructor(message: string, code = 'BUSINESS_RULE_VIOLATION') {
    super(message, 422, code);
  }
}

/** 503 – upstream / external service failure */
export class ExternalServiceError extends AppError {
  constructor(message: string, code = 'EXTERNAL_SERVICE_ERROR') {
    super(message, 503, code);
  }
}

/** 500 – misconfiguration detected at runtime */
export class ConfigurationError extends AppError {
  constructor(message: string, code = 'CONFIGURATION_ERROR') {
    super(message, 500, code);
  }
}
