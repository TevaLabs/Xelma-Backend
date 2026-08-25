import path from 'path';
import swaggerJSDoc from 'swagger-jsdoc';
import { sharedComponents } from './shared-components';

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
              description: 'Stellar wallet public key (G...)',
              example: 'GBRPYHIL2C2V3F5YQZ4H6J7K8L9M0N1O2P3Q4R5S6T7U8V9W0X1Y2Z3A4B',
            },
          },
          required: ['walletAddress'],
          additionalProperties: false,
        },
        AuthChallengeResponse: {
          type: 'object',
          properties: {
            challenge: { type: 'string', example: 'random-challenge-string' },
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
            BTC: { type: 'number', example: 67420.12 },
            ETH: { type: 'number', example: 3241.55 },
            XLM: { type: 'number', example: 0.2891 },
            stale: { type: 'boolean', example: false },
            lastUpdatedAt: { type: 'string', format: 'date-time', nullable: true },
          },
          required: ['BTC', 'ETH', 'XLM', 'stale', 'lastUpdatedAt'],
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
            entryFee: { type: 'string' },
            prizePool: { type: 'string' },
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
  ],
});

// Add /api/health path which the hackathon app serves via apiRouter.use('/', healthRoutes)
// but whose JSDoc annotation uses the /health prefix.
(hackathonSwaggerSpec as any).paths = (hackathonSwaggerSpec as any).paths || {};
(hackathonSwaggerSpec as any).paths['/api/health'] = {
  get: {
    summary: 'Service health check',
    tags: ['health'],
    responses: {
      '200': { description: 'Health status' },
    },
  },
};
