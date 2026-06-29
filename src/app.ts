import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import routes from './routes';
import healthRoutes from './routes/health';
import statsRoutes from './routes/stats';
import roundsRoutes from './routes/rounds';
import leaderboardRoutes from './routes/leaderboard';
import userRoutes from './routes/user';
import chatRoutes from './routes/chat.routes';
import notificationsRoutes from './routes/notifications.routes';
import { apiRateLimiter, writeRateLimiter } from './middleware/rateLimiter';
import { getHttpCorsOrigins } from './utils/cors';
import { notFoundHandler } from './middleware/notFound'; // Ensure this file exists and outputs JSON
import { errorHandler } from './middleware/errorHandler';
import { hackathonSwaggerSpec } from './docs/hackathon-openapi';
import config from './config';
import logger from './utils/logger';
import { requestIdMiddleware } from './middleware/requestId.middleware';

export interface CreateAppOptions {
  includeErrorHandlers?: boolean;
}

export function createApp(options: CreateAppOptions = {}): Application {
  const { includeErrorHandlers = true } = options;
  const app: Application = express();

  app.use(express.json());
  app.use(
    cors({
      origin: getHttpCorsOrigins(),
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
      credentials: true,
    })
  );
  app.use(helmet());

  // Assign a correlation ID to every request and expose it on the response header
  app.use(requestIdMiddleware);

  // Structured Winston HTTP request logging with duration and correlation ID
  app.use((req: Request, res: Response, next: NextFunction) => {
    const startMs = Date.now();
    // Capture path before sub-router routing strips the prefix from req.url
    const path = req.originalUrl.split('?')[0];
    res.on('finish', () => {
      logger.info('http request', {
        requestId: (req as any).requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Date.now() - startMs,
      });
    });
    next();
  });

  app.get('/docs', (_req, res) => res.redirect(302, '/api-docs'));
  app.get('/api-docs.json', (_req, res) => res.json(hackathonSwaggerSpec));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(hackathonSwaggerSpec, { explorer: true }));

  app.use('/api', apiRateLimiter);
  app.use('/api', writeRateLimiter);
  app.use('/api', healthRoutes);
  app.use('/api/stats', statsRoutes);
  app.use('/api/rounds', roundsRoutes);
  app.use('/api/leaderboard', leaderboardRoutes);
  app.use('/api/user', userRoutes);

  if (config.app.enableMultiplayerSocial) {
    app.use('/api/chat', chatRoutes);
    app.use('/api/notifications', notificationsRoutes);
  }

  app.use('/api', routes);

  // Centralized 404 and Error handlers registered last in the Express stack
  if (includeErrorHandlers) {
    app.use(notFoundHandler);
    app.use(errorHandler);
  }

  return app;
}

const app = createApp();
export default app;