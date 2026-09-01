import path from 'path';
import swaggerJSDoc from 'swagger-jsdoc';
import { sharedComponents } from './shared-components';
import {
  CHALLENGE_EXAMPLE_PUBLIC_KEY,
  CONNECT_EXAMPLE_PUBLIC_KEY,
} from './strkey-fixtures';

const PORT = process.env.PORT || 3001;
const API_BASE_URL = process.env.API_BASE_URL || `http://localhost:${PORT}`;

export const hackathonSwaggerSpec = swaggerJSDoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Xelma Hackathon API',
      description:
        'Hackathon/demo API for wallet auth, price widgets, mock rounds, leaderboard, and platform stats. Use Swagger UI to explore endpoints.',
      version: '1.0.0',
    },
    servers: [{ url: API_BASE_URL }],
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
        AuthChallengeRequest: {
          type: 'object',
          properties: {
            walletAddress: {
              type: 'string',
              description:
                'Stellar wallet public key (G...). Must decode as a valid Ed25519 StrKey.',
              // Cryptographically valid fixture (see src/docs/strkey-fixtures.ts).
              example: CHALLENGE_EXAMPLE_PUBLIC_KEY,
            },
          },
          required: ['walletAddress'],
          additionalProperties: false,
        },
        AuthChallengeResponse: {
          type: 'object',
          description:
            'SEP-10-style challenge (same as production). Challenge string includes Domain/Home Domain for wallet UX. Legacy xelma_auth_* still verifies.',
          properties: {
            challenge: {
              type: 'string',
              example:
                'Xelma Authentication\nDomain: xelma.io\nHome Domain: xelma.io\nNonce: ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12\nIssued At: 2026-09-01T00:00:00.000Z\nVersion: 1\nTimestamp: 1725148800000',
            },
            domain: { type: 'string', example: 'xelma.io' },
            homeDomain: { type: 'string', example: 'xelma.io' },
            expiresAt: { type: 'string', format: 'date-time' },
          },
          required: ['challenge', 'expiresAt'],
          additionalProperties: false,
        },
        AuthConnectRequest: {
          type: 'object',
          properties: {
            // Independent valid StrKey from the challenge example (see
            // src/docs/strkey-fixtures.ts).
            walletAddress: {
              type: 'string',
              description: 'Stellar wallet public key (G...)',
              example: CONNECT_EXAMPLE_PUBLIC_KEY,
            },
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
        // ── Shared base (re-declared via allOf with hackathon-specific fields) ──
        ErrorResponse: {
          allOf: [
            { $ref: '#/components/schemas/BaseErrorResponse' },
            {
              type: 'object',
              properties: {
                requestId: { type: 'string' },
                timestamp: { type: 'string', format: 'date-time' },
              },
            },
          ],
        },
        // ── Shared base schema (imported from shared-components) ──
        ...sharedComponents.schemas,
        NotFoundResponse: {
          type: 'object',
          properties: {
            error: { type: 'string', example: 'Route GET /api/unknown not found' },
            path: { type: 'string', example: '/api/unknown' },
          },
          required: ['error', 'path'],
        },
        PriceResponse: {
          type: 'object',
          description:
            'Multi-asset ticker payload inside the success envelope from GET /api/prices. The hackathon app does not expose GET /api/price (that path is production-only XLM oracle).',
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
        HealthResponse: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['healthy', 'degraded', 'unhealthy'],
              example: 'healthy',
            },
            timestamp: { type: 'string', format: 'date-time' },
            uptime: { type: 'number' },
            durationMs: { type: 'number' },
            services: {
              type: 'object',
              properties: {
                database: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'healthy' },
                    durationMs: { type: 'number' },
                    error: { type: 'string', nullable: true },
                  },
                },
                redis: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'healthy' },
                    durationMs: { type: 'number' },
                    error: { type: 'string', nullable: true },
                  },
                },
                soroban: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'healthy' },
                    durationMs: { type: 'number' },
                    initialized: { type: 'boolean', nullable: true },
                    error: { type: 'string', nullable: true },
                  },
                },
                oracle: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'healthy' },
                    durationMs: { type: 'number' },
                    stale: { type: 'boolean', nullable: true },
                    lastUpdatedAt: {
                      type: 'string',
                      format: 'date-time',
                      nullable: true,
                    },
                    error: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
          required: ['status', 'timestamp', 'uptime', 'durationMs', 'services'],
        },
        PlatformStatsResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                totalRounds: { type: 'integer' },
                totalUsers: { type: 'integer' },
                totalBets: { type: 'integer' },
                isFallback: { type: 'boolean' },
                cachedAt: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
        Tournament: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            mode: { type: 'string', enum: ['UP_DOWN', 'LEGENDS'] },
            status: {
              type: 'string',
              enum: ['UPCOMING', 'ACTIVE', 'COMPLETED', 'CANCELLED'],
            },
            entryFee: { $ref: '#/components/schemas/MoneyAmount' },
            prizePool: { $ref: '#/components/schemas/MoneyAmount' },
            maxParticipants: { type: 'integer' },
            currentParticipants: { type: 'integer' },
            startTime: { type: 'string', format: 'date-time' },
            endTime: { type: 'string', format: 'date-time' },
            rounds: { type: 'integer' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    tags: [
      { name: 'auth', description: 'Wallet authentication and JWT issuance' },
      { name: 'health', description: 'Service health checks' },
      {
        name: 'prices',
        description:
          'Multi-asset live crypto prices via GET /api/prices (CoinGecko). Not the same as production GET /api/price (XLM oracle).',
      },
      { name: 'stats', description: 'Platform statistics' },
      { name: 'rounds', description: 'Mock prediction rounds' },
      { name: 'leaderboard', description: 'Mock leaderboard data' },
      { name: 'tournaments', description: 'Tournament listings and join' },
      { name: 'observability', description: 'Prometheus metrics and readiness probes' },
    ],
  },
  apis: [
    path.join(process.cwd(), 'src/routes/auth.routes.ts'),
    path.join(process.cwd(), 'src/routes/health.ts'),
    path.join(process.cwd(), 'src/routes/index.ts'),
    path.join(process.cwd(), 'src/routes/stats.ts'),
    path.join(process.cwd(), 'src/routes/rounds.routes.ts'),
    path.join(process.cwd(), 'src/routes/leaderboard.ts'),
    path.join(process.cwd(), 'src/routes/tournaments.routes.ts'),
    path.join(process.cwd(), 'src/routes/user.ts'),
  ],
});
