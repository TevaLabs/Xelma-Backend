import swaggerJSDoc from 'swagger-jsdoc';
import { sharedComponents } from './shared-components';

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
              description: 'Stellar wallet public key (G...)',
              example: 'GBRPYHIL2C2V3F5YQZ4H6J7K8L9M0N1O2P3Q4R5S6T7U8V9W0X1Y2Z3A4B',
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
            walletAddress: { type: 'string', description: 'Stellar wallet public key (G...)' },
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

