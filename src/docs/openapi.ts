import swaggerJSDoc from 'swagger-jsdoc';
import { sharedComponents } from './shared-components';
import {
  CHALLENGE_EXAMPLE_PUBLIC_KEY,
  CONNECT_EXAMPLE_PUBLIC_KEY,
} from './strkey-fixtures';

const PORT = process.env.PORT || 3000;
const API_BASE_URL = process.env.API_BASE_URL || `http://localhost:${PORT}`;

export const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Prediction Game API',
      description:
        'API for wallet-authenticated prediction gameplay, leaderboards, rounds, and predictions. Use Swagger UI to explore endpoints and test requests.',
      version: '1.0.0',
    },
    servers: [
      {
        url: API_BASE_URL,
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Paste a JWT like: Bearer <token>',
        },
      },
      schemas: {
        // ── Shared base (re-declared via allOf with production-specific fields) ──
        ErrorResponse: {
          allOf: [
            { $ref: '#/components/schemas/BaseErrorResponse' },
            {
              type: 'object',
              properties: {
                details: {
                  type: 'array',
                  description: 'Field-level validation details (present on validation errors only)',
                  items: {
                    type: 'object',
                    properties: {
                      field: { type: 'string', example: 'walletAddress' },
                      message: { type: 'string', example: 'walletAddress is required' },
                    },
                    required: ['field', 'message'],
                  },
                },
              },
            },
          ],
        },
        // ── Shared base schema (imported from shared-components) ──
        ...sharedComponents.schemas,
        RateLimitResponse: {
          allOf: [{ $ref: '#/components/schemas/ErrorResponse' }],
          example: {
            error: 'AppError',
            message: 'Too many requests from this IP, please try again after 15 minutes',
            code: 'RATE_LIMIT_EXCEEDED',
          },
        },

        AuthChallengeRequest: {
          type: 'object',
          properties: {
            walletAddress: {
              type: 'string',
              description:
                'Stellar wallet public key (G...). Must decode as a valid Ed25519 StrKey.',
              // This example is a cryptographically valid G... public key (see
              // src/docs/strkey-fixtures.ts) so consumers can paste it into a
              // request without tripping the StrKey validation middleware.
              example: CHALLENGE_EXAMPLE_PUBLIC_KEY,
            },
          },
          required: ['walletAddress'],
          additionalProperties: false,
        },
        AuthChallengeResponse: {
          type: 'object',
          description:
            'SEP-10-style challenge. `challenge` is a human-readable message that includes Domain and Home Domain for wallet UX / anti-phishing. `domain`/`homeDomain` duplicate the embedded domains for convenience. Legacy `xelma_auth_*` challenges are still accepted on verify for backward compatibility.',
          properties: {
            challenge: {
              type: 'string',
              example:
                'Xelma Authentication\nDomain: xelma.io\nHome Domain: xelma.io\nAddress: GBRPYHIL2C2V3F5YQZ4H6J7K8L9M0N1O2P3Q4R5S6T7U8V9W0X1Y2Z3A4B\nNonce: ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12\nIssued At: 2026-09-01T00:00:00.000Z\nVersion: 1\nTimestamp: 1725148800000',
            },
            domain: { type: 'string', example: 'xelma.io', description: 'SEP-10 web_auth_domain style' },
            homeDomain: { type: 'string', example: 'xelma.io', description: 'SEP-10 home_domain style' },
            expiresAt: { type: 'string', format: 'date-time' },
          },
          required: ['challenge', 'expiresAt'],
          additionalProperties: false,
        },
        AuthConnectRequest: {
          type: 'object',
          properties: {
            // A different valid StrKey than the challenge example so the two
            // endpoints' docs read as independent, copy-pasteable fixtures.
            walletAddress: { type: 'string', description: 'Stellar wallet public key (G...)', example: CONNECT_EXAMPLE_PUBLIC_KEY },
            challenge: { type: 'string', description: 'Challenge previously returned from /challenge' },
            signature: { type: 'string', description: 'Signature over the challenge' },
          },
          required: ['walletAddress', 'challenge', 'signature'],
          additionalProperties: false,
        },
        AuthConnectResponse: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'JWT access token' },
            user: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                walletAddress: { type: 'string' },
                createdAt: { type: 'string', format: 'date-time' },
                lastLoginAt: { type: 'string', format: 'date-time' },
              },
              required: ['id', 'walletAddress', 'createdAt', 'lastLoginAt'],
              additionalProperties: true,
            },
          },
          required: ['token', 'user'],
          additionalProperties: false,
        },

        LeaderboardEntry: {
          type: 'object',
          properties: {
            rank: { type: 'integer' },
            userId: { type: 'string' },
            walletAddress: { type: 'string' },
            totalEarnings: { $ref: '#/components/schemas/MoneyAmount' },
            totalPredictions: { type: 'integer' },
            accuracy: { type: 'number' },
            modeStats: {
              type: 'object',
              properties: {
                upDown: {
                  type: 'object',
                  properties: {
                    wins: { type: 'integer' },
                    losses: { type: 'integer' },
                    earnings: { $ref: '#/components/schemas/MoneyAmount' },
                    accuracy: { type: 'number' },
                  },
                },
                legends: {
                  type: 'object',
                  properties: {
                    wins: { type: 'integer' },
                    losses: { type: 'integer' },
                    earnings: { $ref: '#/components/schemas/MoneyAmount' },
                    accuracy: { type: 'number' },
                  },
                },
              },
            },
          },
        },
        LeaderboardResponse: {
          type: 'object',
          properties: {
            leaderboard: { type: 'array', items: { $ref: '#/components/schemas/LeaderboardEntry' } },
            userPosition: { $ref: '#/components/schemas/LeaderboardEntry', nullable: true },
            totalUsers: { type: 'number' },
            lastUpdated: { type: 'string' },
          },
          required: ['leaderboard', 'totalUsers', 'lastUpdated'],
          additionalProperties: true,
        },
        UserBalanceResponse: {
          type: 'object',
          properties: {
            balance: { $ref: '#/components/schemas/MoneyAmount' },
          },
          required: ['balance'],
        },
        UserStatsResponse: {
          type: 'object',
          properties: {
            totalPredictions: { type: 'integer' },
            correctPredictions: { type: 'integer' },
            totalEarnings: { $ref: '#/components/schemas/MoneyAmount' },
            upDownEarnings: { $ref: '#/components/schemas/MoneyAmount' },
            legendsEarnings: { $ref: '#/components/schemas/MoneyAmount' },
            pendingWinnings: { $ref: '#/components/schemas/MoneyAmount' },
          },
        },
        PredictionResponse: {
          type: 'object',
          properties: {
            amount: { $ref: '#/components/schemas/MoneyAmount' },
            payout: { $ref: '#/components/schemas/NullableMoneyAmount' },
          },
        },

        RoundResponse: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            mode: { type: 'string', enum: ['UP_DOWN', 'LEGENDS'] },
            status: { type: 'string', enum: ['PENDING', 'ACTIVE', 'LOCKED', 'RESOLVED', 'CANCELLED'] },
            startPrice: { $ref: '#/components/schemas/MoneyAmount' },
            endPrice: { allOf: [{ $ref: '#/components/schemas/NullableMoneyAmount' }], description: 'Decimal string (set on resolution)' },
            startTime: { type: 'string', format: 'date-time' },
            endTime: { type: 'string', format: 'date-time' },
            resolvedAt: { type: 'string', format: 'date-time', nullable: true, description: 'Timestamp of resolution' },
            poolUp: { $ref: '#/components/schemas/MoneyAmount' },
            poolDown: { $ref: '#/components/schemas/MoneyAmount' },
            sorobanRoundId: { type: 'string', nullable: true },
            priceRanges: {
              type: 'array',
              nullable: true,
              description: 'LEGENDS mode only. Range matching uses inclusive lower bounds and exclusive upper bounds, except the final range upper bound is inclusive.',
              items: { $ref: '#/components/schemas/LegendsPriceRange' },
            },
          },
          required: ['id', 'mode', 'status', 'startPrice', 'startTime', 'endTime'],
          additionalProperties: true,
        },
        LegendsPriceRange: {
          type: 'object',
          description: 'Selectable LEGENDS range. Pool tracks total amount staked in the range.',
          properties: {
            min: { type: 'number', description: 'Inclusive lower bound of the range' },
            max: { type: 'number', description: 'Exclusive upper bound of the range (inclusive only for the final configured range)' },
            pool: { $ref: '#/components/schemas/MoneyAmount' },
          },
          required: ['min', 'max'],
          additionalProperties: false,
        },
        PriceResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                BTC: { type: 'number', example: 67420.12 },
                ETH: { type: 'number', example: 3241.55 },
                XLM: { type: 'number', example: 0.2891 },
                stale: { type: 'boolean', example: false },
                lastUpdatedAt: { type: 'string', format: 'date-time', nullable: true },
              },
              required: ['BTC', 'ETH', 'XLM', 'stale', 'lastUpdatedAt'],
            },
          },
          required: ['success', 'data'],
        },
        MultiAssetPriceResponse: {
          type: 'object',
          description:
            'Multi-asset spot prices from GET /api/prices. Not interchangeable with XlmOraclePriceResponse from GET /api/price.',
          properties: {
            BTC: { type: 'number', example: 67420.12 },
            ETH: { type: 'number', example: 3241.55 },
            XLM: { type: 'number', example: 0.2891 },
            stale: { type: 'boolean', example: false },
            lastUpdatedAt: { type: 'string', format: 'date-time', nullable: true },
          },
          required: ['BTC', 'ETH', 'XLM', 'stale', 'lastUpdatedAt'],
        },
        XlmOraclePriceResponse: {
          type: 'object',
          description:
            'Single-asset XLM oracle snapshot from GET /api/price. Not interchangeable with MultiAssetPriceResponse from GET /api/prices.',
          properties: {
            asset: { type: 'string', enum: ['XLM'], example: 'XLM' },
            price_usd: {
              type: 'string',
              nullable: true,
              description: 'XLM/USD as a precise decimal string (null if oracle has no sample yet)',
              example: '0.28910000',
            },
            stale: { type: 'boolean', example: false },
            provider: { type: 'string', nullable: true, example: 'coingecko' },
            lastUpdatedAt: { type: 'string', format: 'date-time', nullable: true },
            source: { type: 'string', nullable: true, example: 'live' },
            timestamp: { type: 'string', format: 'date-time' },
          },
          required: ['asset', 'price_usd', 'stale', 'timestamp'],
        },

        // ── Admin dead-letter queue (Issue #857) ──────────────────────────
        DlqEntry: {
          type: 'object',
          description:
            'A notification or WebSocket dispatch that failed at runtime and was persisted for operator inspection and replay. `payload` is redacted before it leaves the service.',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
              example: '9b2f4c1e-7a3d-4e58-9c60-1d2e3f4a5b6c',
            },
            channel: {
              type: 'string',
              enum: ['NOTIFICATION_CREATE', 'WEBSOCKET_EMIT'],
              description:
                '`NOTIFICATION_CREATE` replays a notification create; `WEBSOCKET_EMIT` replays a real-time event.',
              example: 'NOTIFICATION_CREATE',
            },
            eventName: {
              type: 'string',
              nullable: true,
              description: 'WebSocket event name, or the outbox event type for notification rows.',
              example: 'ROUND_RESOLVED',
            },
            userId: {
              type: 'string',
              nullable: true,
              description: 'Target user, when the failed dispatch was addressed to one.',
              example: 'usr_01J8Z3K4M5N6P7Q8R9S0T1U2V3',
            },
            payload: {
              type: 'object',
              additionalProperties: true,
              description:
                'Original dispatch payload with sensitive values redacted. Never contains credentials or raw wallet secrets.',
              example: {
                userId: 'usr_01J8Z3K4M5N6P7Q8R9S0T1U2V3',
                type: 'WIN',
                title: 'You won!',
                message: 'Your UP bet on round r-42 paid out 12.50000000 XLM.',
                data: { roundId: 'r-42', amount: '12.50000000' },
              },
            },
            attempts: {
              type: 'integer',
              minimum: 1,
              description:
                'Dispatch attempts so far. A row is moved to `ABANDONED` once this reaches the retry cap (default 5).',
              example: 3,
            },
            status: {
              type: 'string',
              enum: ['PENDING', 'RETRYING', 'RESOLVED', 'ABANDONED'],
              description:
                '`PENDING`/`RETRYING` rows are eligible for `retry-all`. `RESOLVED` replays are idempotent no-ops. `ABANDONED` rows exhausted the retry cap and are kept for audit only.',
              example: 'RETRYING',
            },
            lastError: {
              type: 'string',
              description: 'Most recent dispatch error, truncated to 1000 characters.',
              example: 'Error: connect ECONNREFUSED 10.0.0.12:6379',
            },
            lastRetryAt: {
              type: 'string',
              format: 'date-time',
              nullable: true,
              example: '2026-10-22T09:14:00.000Z',
            },
            resolvedAt: {
              type: 'string',
              format: 'date-time',
              nullable: true,
              description: 'Set when a replay succeeds; `null` for pending, retrying, and abandoned rows.',
              example: '2026-10-22T09:15:12.000Z',
            },
            createdAt: { type: 'string', format: 'date-time', example: '2026-10-22T09:12:31.000Z' },
            updatedAt: { type: 'string', format: 'date-time', example: '2026-10-22T09:14:00.000Z' },
          },
          required: [
            'id',
            'channel',
            'eventName',
            'userId',
            'payload',
            'attempts',
            'status',
            'lastError',
            'lastRetryAt',
            'resolvedAt',
            'createdAt',
            'updatedAt',
          ],
        },
        DlqListResponse: {
          type: 'object',
          properties: {
            entries: { type: 'array', items: { $ref: '#/components/schemas/DlqEntry' } },
            total: {
              type: 'integer',
              description: 'Total rows matching the filters (ignoring limit/offset).',
              example: 2,
            },
            limit: { type: 'integer', minimum: 1, maximum: 200, example: 50 },
            offset: { type: 'integer', minimum: 0, example: 0 },
          },
          required: ['entries', 'total', 'limit', 'offset'],
        },
        DlqRetryResponse: {
          type: 'object',
          description: 'Result of replaying one DLQ row.',
          properties: {
            id: { type: 'string', format: 'uuid', example: '9b2f4c1e-7a3d-4e58-9c60-1d2e3f4a5b6c' },
            status: {
              type: 'string',
              enum: ['PENDING', 'RETRYING', 'RESOLVED', 'ABANDONED'],
              example: 'RESOLVED',
            },
            attempts: { type: 'integer', minimum: 1, example: 4 },
          },
          required: ['id', 'status', 'attempts'],
        },
        DlqRetryDryRunResponse: {
          type: 'object',
          description: 'Preview of what a replay would send. Nothing is dispatched or written.',
          properties: {
            dryRun: { type: 'boolean', enum: [true], example: true },
            id: { type: 'string', format: 'uuid', example: '9b2f4c1e-7a3d-4e58-9c60-1d2e3f4a5b6c' },
            channel: {
              type: 'string',
              enum: ['NOTIFICATION_CREATE', 'WEBSOCKET_EMIT'],
              example: 'NOTIFICATION_CREATE',
            },
            eventName: { type: 'string', nullable: true, example: 'ROUND_RESOLVED' },
            userId: { type: 'string', nullable: true, example: 'usr_01J8Z3K4M5N6P7Q8R9S0T1U2V3' },
            status: {
              type: 'string',
              enum: ['PENDING', 'RETRYING', 'RESOLVED', 'ABANDONED'],
              example: 'PENDING',
            },
            attempts: { type: 'integer', minimum: 1, example: 3 },
            redactedPayload: {
              type: 'object',
              additionalProperties: true,
              description: 'Exactly what a replay would dispatch, with secrets redacted.',
              example: {
                userId: 'usr_01J8Z3K4M5N6P7Q8R9S0T1U2V3',
                type: 'WIN',
                title: 'You won!',
                message: 'Your UP bet on round r-42 paid out 12.50000000 XLM.',
                data: { roundId: 'r-42', amount: '12.50000000' },
              },
            },
          },
          required: [
            'dryRun',
            'id',
            'channel',
            'eventName',
            'userId',
            'status',
            'attempts',
            'redactedPayload',
          ],
        },
        DlqRetryAllResponse: {
          type: 'object',
          description: 'Counts for a bulk replay of every `PENDING`/`RETRYING` row.',
          properties: {
            attempted: { type: 'integer', example: 3 },
            resolved: { type: 'integer', description: 'Rows replayed successfully.', example: 1 },
            failed: { type: 'integer', description: 'Rows that failed and remained retryable.', example: 1 },
            abandoned: {
              type: 'integer',
              description: 'Rows moved to `ABANDONED` because they hit the retry cap during this run.',
              example: 1,
            },
          },
          required: ['attempted', 'resolved', 'failed', 'abandoned'],
        },
        DlqRetryAllDryRunResponse: {
          type: 'object',
          properties: {
            dryRun: { type: 'boolean', enum: [true], example: true },
            attempted: { type: 'integer', description: 'Number of rows that would be replayed.', example: 2 },
            previews: { type: 'array', items: { $ref: '#/components/schemas/DlqRetryDryRunResponse' } },
          },
          required: ['dryRun', 'attempted', 'previews'],
        },
      },
    },
    paths: {
      '/api/admin/dead-letter': {
        get: {
          summary: 'List dead-letter queue entries',
          description:
            'Returns failed notification and WebSocket dispatches, newest first. Admin only.\n\n' +
            'Every row records a dispatch that failed at runtime so an operator can inspect it and replay it. ' +
            'Rows start as `PENDING`, move to `RETRYING` after a failed replay, become `RESOLVED` on a successful replay, ' +
            'and are `ABANDONED` once the retry cap is exhausted. Abandoned rows stay in the queue for audit and are not picked up by `retry-all`.\n\n' +
            'Payloads are redacted before they are returned.',
          tags: ['Admin'],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'status',
              in: 'query',
              required: false,
              description: 'Filter by dispatch status. Omit to return every status.',
              schema: { type: 'string', enum: ['PENDING', 'RETRYING', 'RESOLVED', 'ABANDONED'] },
            },
            {
              name: 'channel',
              in: 'query',
              required: false,
              description: 'Filter by dispatch channel. Omit to return both channels.',
              schema: { type: 'string', enum: ['NOTIFICATION_CREATE', 'WEBSOCKET_EMIT'] },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              description: 'Page size, clamped to 1–200.',
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
            {
              name: 'offset',
              in: 'query',
              required: false,
              description: 'Rows to skip; negative values are treated as 0.',
              schema: { type: 'integer', minimum: 0, default: 0 },
            },
          ],
          responses: {
            '200': {
              description: 'A page of DLQ rows, newest first.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/DlqListResponse' },
                  examples: {
                    mixedStatuses: {
                      summary: 'Pending, retrying, resolved, and abandoned rows',
                      value: {
                        entries: [
                          {
                            id: '9b2f4c1e-7a3d-4e58-9c60-1d2e3f4a5b6c',
                            channel: 'NOTIFICATION_CREATE',
                            eventName: 'ROUND_RESOLVED',
                            userId: 'usr_01J8Z3K4M5N6P7Q8R9S0T1U2V3',
                            payload: {
                              userId: 'usr_01J8Z3K4M5N6P7Q8R9S0T1U2V3',
                              type: 'WIN',
                              title: 'You won!',
                              message: 'Your UP bet on round r-42 paid out 12.50000000 XLM.',
                              data: { roundId: 'r-42', amount: '12.50000000' },
                            },
                            attempts: 3,
                            status: 'RETRYING',
                            lastError: 'Error: connect ECONNREFUSED 10.0.0.12:6379',
                            lastRetryAt: '2026-10-22T09:14:00.000Z',
                            resolvedAt: null,
                            createdAt: '2026-10-22T09:12:31.000Z',
                            updatedAt: '2026-10-22T09:14:00.000Z',
                          },
                          {
                            id: '1c4e6a8b-2d3f-4a5b-8c7d-9e0f1a2b3c4d',
                            channel: 'WEBSOCKET_EMIT',
                            eventName: 'round:resolved',
                            userId: null,
                            payload: {
                              eventName: 'round:resolved',
                              room: 'round:r-41',
                              data: { roundId: 'r-41', outcome: 'UP' },
                            },
                            attempts: 5,
                            status: 'ABANDONED',
                            lastError: 'socket hang up',
                            lastRetryAt: '2026-10-22T08:40:09.000Z',
                            resolvedAt: null,
                            createdAt: '2026-10-22T08:31:02.000Z',
                            updatedAt: '2026-10-22T08:40:09.000Z',
                          },
                        ],
                        total: 2,
                        limit: 50,
                        offset: 0,
                      },
                    },
                  },
                },
              },
            },
            '401': { description: 'Missing or invalid JWT' },
            '403': { description: 'Admin access required' },
            '500': { description: 'Failed to list dead-letter entries' },
          },
        },
      },
      '/api/admin/dead-letter/{id}/retry': {
        post: {
          summary: 'Replay one dead-letter queue entry',
          description:
            'Replays a single entry by re-invoking the dispatcher that originally failed. Admin only.\n\n' +
            'On success the row becomes `RESOLVED`. On failure `attempts` is incremented: the row becomes `RETRYING` ' +
            'while below the retry cap (default 5) and `ABANDONED` once the cap is reached. Replaying an already ' +
            '`RESOLVED` row is an idempotent no-op.\n\n' +
            'Pass `dryRun=true` (query or body) to inspect the redacted payload without dispatching anything.',
          tags: ['Admin'],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'Dead-letter entry id.',
              schema: { type: 'string', format: 'uuid' },
            },
            {
              name: 'dryRun',
              in: 'query',
              required: false,
              description: 'Preview the replay without dispatching. `true` or `1`.',
              schema: { type: 'boolean', default: false },
            },
          ],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    dryRun: {
                      type: 'boolean',
                      description: 'Preview the replay without dispatching or writing.',
                      default: false,
                    },
                  },
                  additionalProperties: false,
                },
                examples: {
                  liveReplay: { summary: 'Replay the entry now', value: { dryRun: false } },
                  preview: { summary: 'Preview only', value: { dryRun: true } },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Replay result, or a redacted preview when `dryRun` is set.',
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      { $ref: '#/components/schemas/DlqRetryResponse' },
                      { $ref: '#/components/schemas/DlqRetryDryRunResponse' },
                    ],
                  },
                  examples: {
                    resolved: {
                      summary: 'Replay succeeded',
                      value: { id: '9b2f4c1e-7a3d-4e58-9c60-1d2e3f4a5b6c', status: 'RESOLVED', attempts: 4 },
                    },
                    retrying: {
                      summary: 'Replay failed but the row can be retried again',
                      value: { id: '1c4e6a8b-2d3f-4a5b-8c7d-9e0f1a2b3c4d', status: 'RETRYING', attempts: 4 },
                    },
                    abandoned: {
                      summary: 'Replay failed and the retry cap was reached',
                      value: { id: '1c4e6a8b-2d3f-4a5b-8c7d-9e0f1a2b3c4d', status: 'ABANDONED', attempts: 5 },
                    },
                    dryRun: {
                      summary: 'Preview of the payload a replay would dispatch',
                      value: {
                        dryRun: true,
                        id: '9b2f4c1e-7a3d-4e58-9c60-1d2e3f4a5b6c',
                        channel: 'NOTIFICATION_CREATE',
                        eventName: 'ROUND_RESOLVED',
                        userId: 'usr_01J8Z3K4M5N6P7Q8R9S0T1U2V3',
                        status: 'PENDING',
                        attempts: 3,
                        redactedPayload: {
                          userId: 'usr_01J8Z3K4M5N6P7Q8R9S0T1U2V3',
                          type: 'WIN',
                          title: 'You won!',
                          message: 'Your UP bet on round r-42 paid out 12.50000000 XLM.',
                          data: { roundId: 'r-42', amount: '12.50000000' },
                        },
                      },
                    },
                  },
                },
              },
            },
            '401': { description: 'Missing or invalid JWT' },
            '403': { description: 'Admin access required' },
            '404': { description: 'Dead-letter entry not found' },
            '500': { description: 'Failed to replay dead-letter entry' },
          },
        },
      },
      '/api/admin/dead-letter/retry-all': {
        post: {
          summary: 'Replay every pending/retrying dead-letter entry',
          description:
            'Replays up to `limit` entries with `PENDING` or `RETRYING` status, oldest first. Admin only.\n\n' +
            'Returns a counts summary. Entries that fail during the run stay `RETRYING` until they reach the retry cap, ' +
            'at which point they become `ABANDONED` and are excluded from future bulk replays.\n\n' +
            'Pass `dryRun=true` to receive the redacted previews without dispatching anything.',
          tags: ['Admin'],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'dryRun',
              in: 'query',
              required: false,
              description: 'Preview the bulk replay without dispatching. `true` or `1`.',
              schema: { type: 'boolean', default: false },
            },
          ],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    limit: {
                      type: 'integer',
                      minimum: 1,
                      maximum: 200,
                      default: 50,
                      description: 'Maximum number of rows to replay in this call.',
                    },
                    dryRun: {
                      type: 'boolean',
                      description: 'Preview the bulk replay without dispatching or writing.',
                      default: false,
                    },
                  },
                  additionalProperties: false,
                },
                examples: {
                  bulkReplay: { summary: 'Replay the oldest 50 rows', value: { limit: 50, dryRun: false } },
                  preview: { summary: 'Preview the oldest 10 rows', value: { limit: 10, dryRun: true } },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Counts summary for the bulk replay, or previews when `dryRun` is set.',
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      { $ref: '#/components/schemas/DlqRetryAllResponse' },
                      { $ref: '#/components/schemas/DlqRetryAllDryRunResponse' },
                    ],
                  },
                  examples: {
                    replayed: {
                      summary: 'Bulk replay finished with a mix of outcomes',
                      value: { attempted: 3, resolved: 1, failed: 2, abandoned: 1 },
                    },
                    abandonedOnly: {
                      summary: 'Every attempted row reached the retry cap',
                      value: { attempted: 2, resolved: 0, failed: 2, abandoned: 2 },
                    },
                    dryRun: {
                      summary: 'Preview of the rows that would be replayed',
                      value: {
                        dryRun: true,
                        attempted: 1,
                        previews: [
                          {
                            dryRun: true,
                            id: '9b2f4c1e-7a3d-4e58-9c60-1d2e3f4a5b6c',
                            channel: 'NOTIFICATION_CREATE',
                            eventName: 'ROUND_RESOLVED',
                            userId: 'usr_01J8Z3K4M5N6P7Q8R9S0T1U2V3',
                            status: 'PENDING',
                            attempts: 3,
                            redactedPayload: {
                              userId: 'usr_01J8Z3K4M5N6P7Q8R9S0T1U2V3',
                              type: 'WIN',
                              title: 'You won!',
                              message: 'Your UP bet on round r-42 paid out 12.50000000 XLM.',
                              data: { roundId: 'r-42', amount: '12.50000000' },
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
            '401': { description: 'Missing or invalid JWT' },
            '403': { description: 'Admin access required' },
            '500': { description: 'Failed to replay dead-letter entries' },
          },
        },
      },
    },
    tags: [
      { name: 'auth', description: 'Wallet authentication and JWT issuance' },
      { name: 'user', description: 'User profile, balance, stats, and transactions' },
      { name: 'leaderboard', description: 'Leaderboard and rankings' },
      { name: 'rounds', description: 'Round management and resolution' },
      { name: 'predictions', description: 'Prediction placement and queries' },
      { name: 'education', description: 'Educational guides and tips' },
      { name: 'chat', description: 'Global chat messaging' },
      { name: 'notifications', description: 'User notifications management' },
      { name: 'Admin', description: 'Administrative and operational endpoints' },
      {
        name: 'prices',
        description:
          'Price feeds. GET /api/price is the XLM oracle; GET /api/prices is the multi-asset ticker — different payloads, not aliases.',
      },
    ],
  },
  apis: [
    // Use forward-slash globs so swagger-jsdoc expands on Windows and POSIX.
    'src/routes/*.ts',
    'src/index.ts',
  ],
});

