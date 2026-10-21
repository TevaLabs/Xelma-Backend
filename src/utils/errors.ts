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
  TOURNAMENT_INVALID_STATE = "TOURNAMENT_INVALID_STATE",
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
 * 409 – a tournament lifecycle request was made out of order (Issue #502).
 * Distinct from a generic ConflictError so the saga's bad-state rejections are
 * machine-recognisable and can increment the transition-failure metric.
 */
export class TournamentInvalidStateError extends ConflictError {
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string, message?: string) {
    super(
      message ?? `Invalid tournament state: cannot ${to} a ${from} tournament.`,
      ErrorCode.TOURNAMENT_INVALID_STATE,
    );
    this.name = "TournamentInvalidStateError";
    this.from = from;
    this.to = to;
  }
}

/**
 * 409 – a round lifecycle transition was attempted out of order (e.g.
 * resolving a round that is not LOCKED). Distinct from a generic
 * ConflictError so the round state machine's rejections are
 * machine-recognisable and can increment the transition-failure metric.
 */
export class IllegalRoundTransitionError extends ConflictError {
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string, message?: string) {
    super(
      message ?? `Illegal round transition: cannot transition a ${from} round to ${to}.`,
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
    code: ErrorCode.TOURNAMENT_INVALID_STATE,
    status: 409,
    errorClass: "TournamentInvalidStateError",
    description:
      "Tournament lifecycle request made out of order (e.g. locking a tournament " +
      "that is not UPCOMING, or settling one that never locked).",
  },
];

/**
 * One rule of the Soroban error mapping table.
 *
 * The rule owns the *raw chain text* that identifies the failure and the
 * consumer-facing message; everything else (HTTP status, error class) is
 * resolved from {@link ERROR_CATALOG} via {@link SorobanErrorRule.code}, so
 * the catalog stays the single source of truth.
 */
export interface SorobanErrorRule {
  /**
   * Lower-case substrings that identify this rule. A rule matches when the
   * raw error text contains any of them. Order matters — the first matching
   * rule wins, so more specific rules come first.
   */
  readonly patterns: readonly string[];
  /** Catalog code emitted for this rule. */
  readonly code: ErrorCode;
  /** Safe, consumer-facing message. Never leaks chain jargon. */
  readonly message: string;
}

/**
 * Soroban/RPC error text → catalog code.
 *
 * This is the table that replaced the old if/else chain in
 * {@link mapSorobanError}. Adding a new chain failure means adding a row
 * here — the error class and HTTP status still come from the catalog, so
 * they cannot drift apart.
 */
export const SOROBAN_ERROR_RULES: readonly SorobanErrorRule[] = [
  {
    patterns: ["insufficient funds"],
    code: ErrorCode.INSUFFICIENT_FUNDS,
    message: "Insufficient funds for contract operation.",
  },
  {
    patterns: ["no pending", "nothing to claim", "already claimed"],
    code: ErrorCode.CONTRACT_INVALID_STATE,
    message: "No claimable winnings available.",
  },
  {
    patterns: ["invalid state"],
    code: ErrorCode.CONTRACT_INVALID_STATE,
    message: "Contract operation rejected due to invalid state.",
  },
  {
    patterns: ["timeout"],
    code: ErrorCode.EXTERNAL_SERVICE_ERROR,
    message: "Contract operation timed out.",
  },
  {
    patterns: ["circuit breaker"],
    code: ErrorCode.EXTERNAL_SERVICE_ERROR,
    message: "Contract service temporarily unavailable. Please retry shortly.",
  },
];

/**
 * Builds an AppError of the catalog's error class for `code`.
 *
 * The catalog stores the class as a string, so it is resolved back to a
 * constructor here. Each factory receives the (message, code) pair the class
 * expects — ValidationError takes details as its second argument, so it is
 * constructed without a code and keeps its own default.
 */
function createCatalogError(
  entry: ErrorCatalogEntry,
  message: string,
  code: ErrorCode
): AppError {
  switch (entry.errorClass) {
    case "ValidationError":
      return new ValidationError(message);
    case "AuthenticationError":
      return new AuthenticationError(message, code);
    case "AuthorizationError":
      return new AuthorizationError(message, code);
    case "NotFoundError":
      return new NotFoundError(message, code);
    case "ConflictError":
      return new ConflictError(message, code);
    case "BusinessRuleError":
      return new BusinessRuleError(message, code);
    case "ExternalServiceError":
      return new ExternalServiceError(message, code);
    case "ConfigurationError":
      return new ConfigurationError(message, code);
    default:
      return new AppError(message, entry.status, code);
  }
}

/**
 * Maps raw Soroban RPC/contract error messages into stable, safe AppErrors.
 *
 * Lookup order:
 *   1. {@link SOROBAN_ERROR_RULES} maps the raw chain text to a catalog code.
 *   2. {@link ERROR_CATALOG} supplies the HTTP status and error class.
 *
 * Falls back to EXTERNAL_SERVICE_ERROR for unmatched messages, never leaking
 * chain jargon to API consumers.
 */
export function mapSorobanError(errorMsg: string | undefined): AppError {
  const msg = (errorMsg || "").toLowerCase();

  const rule = SOROBAN_ERROR_RULES.find((candidate) =>
    candidate.patterns.some((pattern) => msg.includes(pattern))
  );

  const code = rule?.code ?? ErrorCode.EXTERNAL_SERVICE_ERROR;
  const message =
    rule?.message ?? "An unexpected contract error occurred.";

  const catalogEntry = ERROR_CATALOG.find((entry) => entry.code === code);
  if (!catalogEntry) {
    // The catalog is the source of truth; without an entry we cannot honour
    // the code, so fall back to the generic upstream failure.
    return new ExternalServiceError(message, ErrorCode.EXTERNAL_SERVICE_ERROR);
  }

  return createCatalogError(catalogEntry, message, code);
}
