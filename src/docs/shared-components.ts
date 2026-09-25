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
          description: 'Error class name (e.g. ValidationError, AuthenticationError, NotFoundError)',
          example: 'ValidationError',
        },
        message: {
          type: 'string',
          description: 'Human-readable description of the error',
          example: 'walletAddress is required',
        },
        code: {
          type: 'string',
          description: 'Machine-readable error code for programmatic handling',
          example: 'VALIDATION_ERROR',
        },
        path: {
          type: 'string',
          description: 'Request path that resulted in the error',
          example: '/api/bets/claim',
        },
        requestId: {
          type: 'string',
          description: 'Unique request correlation ID',
          example: '12345678-1234-1234-1234-123456789012',
        },
        timestamp: {
          type: 'string',
          format: 'date-time',
          description: 'ISO 8601 timestamp of error occurrence',
          example: '2026-09-25T10:00:00.000Z',
        },
      },
      required: ['error', 'message', 'code', 'path', 'requestId', 'timestamp'],
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
