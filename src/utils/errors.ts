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
  IDEMPOTENCY_KEY_CONFLICT = "IDEMPOTENCY_KEY_CONFLICT",
  CONTRACT_INVALID_STATE = "CONTRACT_INVALID_STATE",
  ILLEGAL_ROUND_TRANSITION = "ILLEGAL_ROUND_TRANSITION",
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

/**
 * 409 – a round attempted a status transition the lifecycle state machine
 * forbids (Issue #490). Distinct from a generic ConflictError so the error
 * handler can surface the offending from/to pair to callers and operators.
 */
export class IllegalRoundTransitionError extends ConflictError {
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string, message?: string) {
    super(
      message ??
        `Illegal round transition: ${from} -> ${to} is not a valid lifecycle edge.`,
      ErrorCode.ILLEGAL_ROUND_TRANSITION,
    );
    this.name = "IllegalRoundTransitionError";
    this.from = from;
    this.to = to;
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

/**
 * 503 – in-flight cap exceeded on a money/RPC path.
 * Distinct from a generic upstream failure so the error handler can set Retry-After.
 */
export class BackpressureError extends ExternalServiceError {
  readonly retryAfterSeconds: number;

  constructor(
    message = "Too many in-flight money-path operations. Please retry shortly.",
    retryAfterSeconds = 1,
  ) {
    super(message, ErrorCode.EXTERNAL_SERVICE_ERROR);
    this.name = "BackpressureError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 500 – misconfiguration detected at runtime */
export class ConfigurationError extends AppError {
  constructor(message: string, code: ErrorCode | string = ErrorCode.CONFIGURATION_ERROR) {
    super(message, 500, code);
  }
}

/**
 * Unified backend error code catalog (#196).
 *
 * Single source of truth that maps every {@link ErrorCode} to the
 * HTTP status the API will use, the error class that produces it, and
 * a short, human-readable description an API consumer can act on.
 *
 * Consumed by:
 *   - The README for the public error reference table.
 *   - The OpenAPI doc so each error appears alongside the endpoints
 *     that can return it.
 *   - The unit test that pins the catalog and prevents drift from
 *     the actual ErrorCode enum.
 */
export interface ErrorCatalogEntry {
  /** Machine-readable code shipped on the wire in `error.code`. */
  code: ErrorCode;
  /** HTTP status this error maps to in responses. */
  status: number;
  /** Name of the AppError subclass that emits this code. */
  errorClass: string;
  /** Short, action-oriented description for API consumers. */
  description: string;
}

export const ERROR_CATALOG: readonly ErrorCatalogEntry[] = [
  {
    code: ErrorCode.VALIDATION_ERROR,
    status: 400,
    errorClass: "ValidationError",
    description:
      "Request body, query string, or path params failed schema validation. " +
      "Fix the offending fields described in `error.details`.",
  },
  {
    code: ErrorCode.AUTHENTICATION_ERROR,
    status: 401,
    errorClass: "AuthenticationError",
    description:
      "Missing, malformed, or invalid credentials. Acquire a fresh JWT via " +
      "the wallet challenge → connect flow and retry.",
  },
  {
    code: ErrorCode.AUTHORIZATION_ERROR,
    status: 403,
    errorClass: "AuthorizationError",
    description:
      "Authenticated, but not permitted for this resource or action.",
  },
  {
    code: ErrorCode.NOT_FOUND,
    status: 404,
    errorClass: "NotFoundError",
    description: "The requested resource does not exist.",
  },
  {
    code: ErrorCode.CONFLICT,
    status: 409,
    errorClass: "ConflictError",
    description:
      "The request conflicts with current server state. Re-read the resource " +
      "and retry.",
  },
  {
    code: ErrorCode.BUSINESS_RULE_VIOLATION,
    status: 422,
    errorClass: "BusinessRuleError",
    description:
      "Request was well-formed but violated a domain rule (e.g. round closed, " +
      "duplicate prediction).",
  },
  {
    code: ErrorCode.EXTERNAL_SERVICE_ERROR,
    status: 503,
    errorClass: "ExternalServiceError",
    description:
      "Upstream dependency (database, Soroban RPC, oracle) is unavailable or " +
      "returned an unexpected error. Retry with backoff.",
  },
  {
    code: ErrorCode.CONFIGURATION_ERROR,
    status: 500,
    errorClass: "ConfigurationError",
    description:
      "Server misconfiguration detected at runtime. Operators must intervene; " +
      "client retry will not help.",
  },
  {
    code: ErrorCode.INTERNAL_SERVER_ERROR,
    status: 500,
    errorClass: "AppError",
    description:
      "Unexpected server error. Retry; if it persists, include the response's " +
      "`requestId` when filing a bug.",
  },
  {
    code: ErrorCode.INVALID_CHALLENGE,
    status: 401,
    errorClass: "AuthenticationError",
    description:
      "The signed challenge does not match any known issued challenge. Restart " +
      "the wallet sign-in from the challenge endpoint.",
  },
  {
    code: ErrorCode.CHALLENGE_EXPIRED,
    status: 401,
    errorClass: "AuthenticationError",
    description: "Challenge TTL has elapsed. Request a new challenge and sign it again.",
  },
  {
    code: ErrorCode.CHALLENGE_USED,
    status: 401,
    errorClass: "AuthenticationError",
    description:
      "Challenge has already been consumed (challenges are one-shot). Request " +
      "a fresh one.",
  },
  {
    code: ErrorCode.INVALID_SIGNATURE,
    status: 401,
    errorClass: "AuthenticationError",
    description:
      "Signature does not verify against the supplied wallet address and " +
      "challenge payload.",
  },
  {
    code: ErrorCode.INSUFFICIENT_FUNDS,
    status: 422,
    errorClass: "BusinessRuleError",
    description:
      "Wallet does not have the required balance for the requested operation.",
  },
  {
    code: ErrorCode.ROUND_NOT_ACTIVE,
    status: 422,
    errorClass: "BusinessRuleError",
    description: "Target round is not in ACTIVE status and cannot accept this action.",
  },
  {
    code: ErrorCode.ROUND_LOCKED,
    status: 422,
    errorClass: "BusinessRuleError",
    description:
      "Round has been locked ahead of resolution; predictions are no longer accepted.",
  },
  {
    code: ErrorCode.ROUND_ALREADY_RESOLVED,
    status: 409,
    errorClass: "ConflictError",
    description: "Round has already been resolved and its outcome is final.",
  },
  {
    code: ErrorCode.DUPLICATE_PREDICTION,
    status: 409,
    errorClass: "ConflictError",
    description: "User already has a prediction for this round.",
  },
  {
    code: ErrorCode.ACTIVE_ROUND_EXISTS,
    status: 409,
    errorClass: "ConflictError",
    description:
      "An active round of the requested mode already exists; start cannot proceed.",
  },
  {
    code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT,
    status: 409,
    errorClass: "ConflictError",
    description:
      "The Idempotency-Key was already used for a different request payload. " +
      "Retry the original payload or generate a new key.",
  },
  {
    code: ErrorCode.CONTRACT_INVALID_STATE,
    status: 422,
    errorClass: "BusinessRuleError",
    description:
      "Contract operation rejected due to invalid state on the blockchain.",
  },
  {
    code: ErrorCode.ILLEGAL_ROUND_TRANSITION,
    status: 409,
    errorClass: "IllegalRoundTransitionError",
    description:
      "Round status change skipped a valid lifecycle state (e.g. trying to resolve " +
      "an open round, or re-settle an already-final round).",
  },
];

/**
 * Maps raw Soroban RPC/contract error messages into stable, safe AppErrors.
 * Protects internal details from leaking while providing actionable codes.
 */
export function mapSorobanError(errorMsg: string | undefined): AppError {
  const msg = (errorMsg || "").toLowerCase();

  if (msg.includes("insufficient funds")) {
    return new BusinessRuleError(
      "Insufficient funds for contract operation.",
      ErrorCode.INSUFFICIENT_FUNDS
    );
  }

  if (
    msg.includes("no pending") ||
    msg.includes("nothing to claim") ||
    msg.includes("already claimed")
  ) {
    return new BusinessRuleError(
      "No claimable winnings available.",
      ErrorCode.CONTRACT_INVALID_STATE
    );
  }

  if (msg.includes("invalid state")) {
    return new BusinessRuleError(
      "Contract operation rejected due to invalid state.",
      ErrorCode.CONTRACT_INVALID_STATE
    );
  }

  if (msg.includes("timeout")) {
    return new ExternalServiceError(
      "Contract operation timed out.",
      ErrorCode.EXTERNAL_SERVICE_ERROR
    );
  }

  if (msg.includes("circuit breaker")) {
    return new ExternalServiceError(
      "Contract service temporarily unavailable. Please retry shortly.",
      ErrorCode.EXTERNAL_SERVICE_ERROR
    );
  }

  // Fallback for unknown errors (does not leak chain jargon)
  return new ExternalServiceError(
    "An unexpected contract error occurred.",
    ErrorCode.EXTERNAL_SERVICE_ERROR
  );
}
