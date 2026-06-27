import path from 'path';
import swaggerJSDoc from 'swagger-jsdoc';

const PORT = process.env.PORT || 3001;
const API_BASE_URL = process.env.API_BASE_URL || `http://localhost:${PORT}`;

export const hackathonSwaggerSpec = swaggerJSDoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Xelma Hackathon API',
      description:
        'Hackathon/demo API for price widgets, mock rounds, leaderboard, and platform stats. Use Swagger UI to explore endpoints.',
      version: '1.0.0',
    },
    servers: [{ url: API_BASE_URL }],
    components: {
      schemas: {
        ErrorResponse: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
            code: { type: 'string' },
            requestId: { type: 'string' },
            timestamp: { type: 'string', format: 'date-time' },
          },
          required: ['error', 'message', 'code'],
        },
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
            status: { type: 'string', example: 'ok' },
            timestamp: { type: 'number', example: 1719494400000 },
          },
          required: ['status', 'timestamp'],
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
      },
    },
    tags: [
      { name: 'health', description: 'Service health checks' },
      { name: 'prices', description: 'Live crypto prices (CoinGecko)' },
      { name: 'stats', description: 'Platform statistics' },
      { name: 'rounds', description: 'Mock prediction rounds' },
      { name: 'leaderboard', description: 'Mock leaderboard data' },
    ],
  },
  apis: [
    path.join(process.cwd(), 'src/routes/health.ts'),
    path.join(process.cwd(), 'src/routes/index.ts'),
    path.join(process.cwd(), 'src/routes/stats.ts'),
    path.join(process.cwd(), 'src/routes/rounds.ts'),
    path.join(process.cwd(), 'src/routes/leaderboard.ts'),
  ],
});
