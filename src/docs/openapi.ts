import path from 'path';
import swaggerJSDoc from 'swagger-jsdoc';

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
        ErrorResponse: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['error'],
          additionalProperties: true,
        },
        RateLimitResponse: {
          allOf: [{ $ref: '#/components/schemas/ErrorResponse' }],
          example: {
            error: 'Too Many Requests',
            message: 'Too many requests from this IP, please try again after 15 minutes',
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

        LeaderboardResponse: {
          type: 'object',
          properties: {
            leaderboard: { type: 'array', items: { type: 'object' } },
            userPosition: { type: 'object', nullable: true },
            totalUsers: { type: 'number' },
            lastUpdated: { type: 'string' },
          },
          required: ['leaderboard', 'totalUsers', 'lastUpdated'],
          additionalProperties: true,
        },

        RoundResponse: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            mode: { type: 'string', enum: ['UP_DOWN', 'LEGENDS'] },
            status: { type: 'string', enum: ['PENDING', 'ACTIVE', 'LOCKED', 'RESOLVED', 'CANCELLED'] },
            startPrice: { type: 'string', description: 'Decimal string' },
            endPrice: { type: 'string', nullable: true, description: 'Decimal string (set on resolution)' },
            startTime: { type: 'string', format: 'date-time' },
            endTime: { type: 'string', format: 'date-time' },
            resolvedAt: { type: 'string', format: 'date-time', nullable: true, description: 'Timestamp of resolution' },
            poolUp: { type: 'string', description: 'Decimal string' },
            poolDown: { type: 'string', description: 'Decimal string' },
            sorobanRoundId: { type: 'string', nullable: true },
            priceRanges: { type: 'array', nullable: true, items: { type: 'object' } },
          },
          required: ['id', 'mode', 'status', 'startPrice', 'startTime', 'endTime'],
          additionalProperties: true,
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
    ],
  },
  apis: [
    path.join(process.cwd(), 'src/routes/*.ts'),
    path.join(process.cwd(), 'src/index.ts'),
  ],
});

