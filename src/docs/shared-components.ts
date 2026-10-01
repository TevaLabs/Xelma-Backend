/**
 * Shared OpenAPI 3.0 components used by both the production and hackathon specs.
 *
 * Keeping shared schemas here ensures that when an API contract changes, both
 * specs stay in sync — no more copy-paste drift between openapi.ts and
 * hackathon-openapi.ts.
 *
 * ─── Guidelines ───────────────────────────────────────────────────────────────
 * 1. Put **common** schemas here (e.g. the base ErrorResponse that both specs
 *    reference via allOf).
 * 2. Keep **mode-specific** schemas in the respective spec file — only put
 *    something here if it is referenced by (or relevant to) both the production
 *    and hackathon OpenAPI documents.
 * 3. When a shared schema needs mode-specific fields, define the base here and
 *    use allOf + $ref to extend it in each spec file.
 *
 * ─── Naming ───────────────────────────────────────────────────────────────────
 * Schemas are prefixed with "Base" when they are meant to be composed via allOf
 * into the mode-specific ErrorResponse schema.  Each spec file re-exports the
 * final ErrorResponse under its own name.
 */

export const sharedComponents = {
  schemas: {
    /**
     * Base ErrorResponse shared by both production and hackathon specs.
     *
     * Production extends this with a `details` array (field-level validation
     * errors).  The hackathon spec extends it with `requestId` and `timestamp`.
     *
     * Each spec re-declares the full ErrorResponse via allOf so generated SDKs
     * and Swagger UI show the correct field set for that mode.
     */
    BaseErrorResponse: {
      type: 'object',
      description: 'Standard error response returned by all API endpoints on failure.',
      properties: {
        error: {
          type: 'string',
          description: 'Error class name or textual summary (e.g. ValidationError, AuthenticationError, Too Many Requests)',
          example: 'AuthenticationError',
        },
        message: {
          type: 'string',
          description: 'Human-readable description of the error',
          example: 'No token provided',
        },
        code: {
          type: 'string',
          description: 'Machine-readable error code for programmatic handling',
          example: 'AUTHENTICATION_ERROR',
        },
        path: {
          type: 'string',
          description: 'Request path that produced this error',
          example: '/api/bets/up-down',
        },
        requestId: {
          type: 'string',
          description: 'Unique request correlation ID for tracing',
          example: 'c2b4e891-6f34-4b5a-9a8c-2f9e4d5c6b7a',
        },
        timestamp: {
          type: 'string',
          format: 'date-time',
          description: 'ISO-8601 timestamp of when the error occurred',
          example: '2026-09-28T12:00:00.000Z',
        },
        retryAfter: {
          type: 'integer',
          description: 'Seconds until the client can retry (present on 429 and backpressure responses)',
          example: 60,
        },
      },
      required: ['error', 'message', 'code'],
    },
    UnauthorizedResponse: {
      allOf: [{ $ref: '#/components/schemas/ErrorResponse' }],
      description: 'Returned when a request lacks a valid JWT bearer token.',
      example: {
        error: 'AuthenticationError',
        message: 'No token provided',
        code: 'AUTHENTICATION_ERROR',
        path: '/api/bets/up-down',
        requestId: 'c2b4e891-6f34-4b5a-9a8c-2f9e4d5c6b7a',
        timestamp: '2026-09-28T12:00:00.000Z',
      },
    },
    ForbiddenResponse: {
      allOf: [{ $ref: '#/components/schemas/ErrorResponse' }],
      description: 'Returned when the authenticated user does not have permission or wallet mismatch occurs.',
      example: {
        error: 'ForbiddenError',
        message: 'Wallet address does not match authenticated user',
        code: 'FORBIDDEN',
        path: '/api/bets/up-down',
        requestId: 'c2b4e891-6f34-4b5a-9a8c-2f9e4d5c6b7a',
        timestamp: '2026-09-28T12:00:00.000Z',
      },
    },
    RateLimitResponse: {
      allOf: [{ $ref: '#/components/schemas/ErrorResponse' }],
      description: 'Returned when the request rate limit has been exceeded.',
      example: {
        error: 'Too Many Requests',
        message: 'Too many bet submissions from this IP. Please wait before placing another bet.',
        code: 'RATE_LIMIT_EXCEEDED',
        path: '/api/bets/up-down',
        requestId: 'c2b4e891-6f34-4b5a-9a8c-2f9e4d5c6b7a',
        timestamp: '2026-09-28T12:00:00.000Z',
        retryAfter: 60,
      },
    },
    ValidationErrorResponse: {
      allOf: [{ $ref: '#/components/schemas/ErrorResponse' }],
      description: 'Returned when request payload fails schema validation.',
      properties: {
        details: {
          type: 'array',
          description: 'Field-level validation error details.',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', example: 'amount' },
              message: { type: 'string', example: 'amount must be greater than 0' },
            },
            required: ['field', 'message'],
          },
        },
      },
      example: {
        error: 'ValidationError',
        message: 'Invalid request payload',
        code: 'VALIDATION_ERROR',
        path: '/api/bets/up-down',
        requestId: 'c2b4e891-6f34-4b5a-9a8c-2f9e4d5c6b7a',
        timestamp: '2026-09-28T12:00:00.000Z',
        details: [
          {
            field: 'amount',
            message: 'amount must be a valid positive number',
          },
        ],
      },
    },
    MoneyAmount: {
      type: 'string',
      description:
        'Canonical monetary amount: a Decimal(20,8) serialized as a string with exactly 8 fractional digits. Never a JSON number — IEEE-754 floats cannot represent stroop-scale values safely.',
      pattern: '^-?\\d+\\.\\d{8}$',
      example: '1000.33333333',
    },
    NullableMoneyAmount: {
      type: 'string',
      nullable: true,
      description: 'Optional monetary amount. Null when the value is unset (e.g. unresolved payout or end price).',
      pattern: '^-?\\d+\\.\\d{8}$',
      example: '15.50000000',
    },
  },
};
