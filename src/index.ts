// Enforce Node.js 22+ runtime requirement at startup before loading any modules
const nodeMajorVersion = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajorVersion < 22) {
  console.error(`🔥 CRITICAL ERROR: Application startup failed.`);
  console.error(`Node.js v22.x or higher is required. You are running v${process.version}.`);
  console.error(`Please upgrade Node.js to avoid local vs Render mismatches.`);
  process.exit(1);
}

import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { assertPreflightOrExit } from './config/preflight';
import { createServer, Server as HttpServer } from 'http';
import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import roundsRoutes from './routes/rounds.routes';
import betsRoutes from './routes/bets.routes';
import predictionsRoutes from './routes/predictions.routes';
import educationRoutes from './routes/education.routes';
import leaderboardRoutes from './routes/leaderboard.routes';
import notificationsRoutes from './routes/notifications.routes';
import priceOracle from './services/oracle';
import sorobanService from './services/soroban.service';
import websocketService from './services/websocket.service';
import schedulerService from './services/scheduler.service';
import roundSchedulerService from './services/round-scheduler.service';
import logger from './utils/logger';
import { validateVendoredBindings } from './utils/bindings-validator';
import { errorHandler } from './middleware/errorHandler.middleware';
import { metricsMiddleware } from './middleware/metrics.middleware';
import { requestIdMiddleware } from './middleware/requestId.middleware';
import metricsRoutes from './routes/metrics.routes';
import adminMetricsRoutes from './routes/admin-metrics.routes';
import errorsRoutes from './routes/errors.routes';
import corsDiagnosticsRoutes from './routes/admin-cors-diagnostics.routes';
import deadLetterRoutes from './routes/admin-dead-letter.routes';
import chatRoutes from './routes/chat.routes';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './docs/openapi';
import { initializeSocket } from './socket';
import { prisma } from './lib/prisma';
import path from 'path';

const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile), override: false });
dotenv.config({ override: false });

export { getHttpCorsOrigins } from './utils/cors';
import { getHttpCorsOrigins } from './utils/cors';

/**
 * Apply security headers to every response.
 * Prevents common browser-based attacks without adding helmet as a dependency.
 */
function securityHeaders(
   _req: Request,
   res: Response,
   next: NextFunction
): void {
   res.setHeader('X-Content-Type-Options', 'nosniff');
   res.setHeader('X-Frame-Options', 'DENY');
   res.setHeader('X-XSS-Protection', '1; mode=block');
   res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
   res.setHeader('Content-Security-Policy', "default-src 'self'");
   res.setHeader(
      'Permissions-Policy',
      'geolocation=(), camera=(), microphone=()'
   );
   next();
}

const validateEnv = (): void => {
   if (!process.env.JWT_SECRET) {
      console.error('🔥 CRITICAL ERROR: Application startup failed.');
      console.error('Missing required environment variable: JWT_SECRET');
      console.error(
         'Please configure this securely in your environment before starting the app.'
      );
      process.exit(1); // 1 indicates a failure/error state
   }
};

/**
 * Validate the vendored @tevalabs/xelma-bindings package at startup so a
 * stale or partial vendor surfaces immediately, instead of as an opaque
 * "Cannot find module" deep inside the Soroban service later. Only logs —
 * never throws — because API-only deployments may run without Soroban.
 */
function logBindingsValidation(): void {
   const result = validateVendoredBindings();
   if (result.ok) {
      logger.info('Vendored bindings OK', {
         vendorPath: result.info.vendorPath,
         packageName: result.info.packageName,
         commitSha: result.info.commitSha,
      });
   } else {
      logger.warn(
         'Vendored bindings validation failed; Soroban integration may fail at runtime',
         {
            vendorPath: result.info.vendorPath,
            errors: result.errors,
            commitSha: result.info.commitSha,
         }
      );
   }
}

// Run preflight gate before anything else initializes
assertPreflightOrExit();

// Execute validation immediately
validateEnv();
logBindingsValidation();

/**
 * Create and configure the Express app without starting any background
 * jobs or binding to a network port. Safe to import in tests.
 */
export function createApp(): Express {
   const app = express();

   // Security headers (before all routes)
   app.use(securityHeaders);

   // CORS — origin allowlist is driven by CLIENT_URL / ALLOWED_ORIGINS env vars
   app.use(
      cors({
         origin: getHttpCorsOrigins(),
         methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
         allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
         credentials: true,
      })
   );

   app.use(express.json());
   app.use(express.urlencoded({ extended: true }));

   // Request ID middleware (first, so all subsequent middleware has access)
   app.use(requestIdMiddleware);

   // Prometheus metrics middleware (before routes so all requests are tracked)
   app.use(metricsMiddleware);

   // Request logging middleware
   app.use((req: Request, res: Response, next: NextFunction) => {
      const requestId = (req as any).requestId;
      logger.info(`${req.method} ${req.path}`, { requestId });
      next();
   });

   // API Routes
   app.use('/api/auth', authRoutes);
   app.use('/api/user', userRoutes);
   app.use('/api/rounds', roundsRoutes);
   app.use('/api/bets', betsRoutes);
   app.use('/api/predictions', predictionsRoutes);
   app.use('/api/education', educationRoutes);
   app.use('/api/leaderboard', leaderboardRoutes);
   app.use('/api/chat', chatRoutes);
   app.use('/api/notifications', notificationsRoutes);
   app.use('/api/admin/metrics', adminMetricsRoutes);
   app.use('/api/errors', errorsRoutes);
   app.use('/api/admin/cors-diagnostics', corsDiagnosticsRoutes);
   app.use('/api/admin/dead-letter', deadLetterRoutes);

   // Prometheus metrics endpoint
   app.use('/metrics', metricsRoutes);

   // Swagger UI (OpenAPI)
   app.get('/docs', (req: Request, res: Response) =>
      res.redirect(302, '/api-docs')
   );
   app.get('/api-docs.json', (req: Request, res: Response) =>
      res.json(swaggerSpec)
   );
   app.use(
      '/api-docs',
      swaggerUi.serve,
      swaggerUi.setup(swaggerSpec, { explorer: true })
   );

   // Hello World endpoint
   app.get('/', (req: Request, res: Response) => {
      res.json({
         message: 'Hello World! Xelma Backend is running',
         timestamp: new Date().toISOString(),
         status: 'OK',
      });
   });

   // Health check endpoint
   app.get('/health', async (req: Request, res: Response) => {
      const startTime = Date.now();
      let dbStatus = 'unhealthy';
      let dbDurationMs = 0;
      let overallStatus = 'healthy';

      // Check database connectivity with bounded timeout
      try {
         const dbCheckStart = Date.now();
         await Promise.race([
            prisma.$queryRaw`SELECT 1`,
            new Promise((_, reject) =>
               setTimeout(
                  () => reject(new Error('DB health check timeout')),
                  5000
               )
            ),
         ]);
         dbStatus = 'healthy';
         dbDurationMs = Date.now() - dbCheckStart;
         logger.debug('Database health check passed', { dbDurationMs });
      } catch (dbError: any) {
         dbStatus = 'unhealthy';
         dbDurationMs = Date.now() - startTime;
         overallStatus = 'degraded';
         logger.warn('Database health check failed', {
            error: dbError?.message || 'Unknown error',
            dbDurationMs,
         });
      }

      // Check Soroban service health
      let sorobanHealth;
      try {
         sorobanHealth = await sorobanService.getHealth();
      } catch (error: any) {
         logger.warn('Soroban health check failed', { error: error?.message });
         sorobanHealth = { initialized: false, error: 'Health check failed' };
      }

      const responseCode = overallStatus === 'healthy' ? 200 : 503;
      const totalDurationMs = Date.now() - startTime;

      res.status(responseCode).json({
         status: overallStatus,
         uptime: process.uptime(),
         timestamp: new Date().toISOString(),
         durationMs: totalDurationMs,
         services: {
            soroban: sorobanHealth,
            database: {
               status: dbStatus,
               durationMs: dbDurationMs,
               timeout: 5000,
            },
         },
      });
   });

   // Price Oracle endpoint (returns price_usd as a precise decimal string)
   app.get('/api/price', (req: Request, res: Response) => {
      const price = priceOracle.getPriceString();
      const lastUpdatedAt = priceOracle.getLastUpdatedAt();
      res.json({
         asset: 'XLM',
         price_usd: price,
         stale: priceOracle.isStale(),
         lastUpdatedAt: lastUpdatedAt?.toISOString() ?? null,
         timestamp: new Date().toISOString(),
      });
   });

   // 404 handler - forward to error handler for consistent response format
   app.use((req: Request, res: Response, next: NextFunction) => {
      const { NotFoundError } = require('./utils/errors');
      next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
   });

   // Centralized error handler (must be last)
   app.use(errorHandler);

   return app;
}

interface ServerHandle {
   httpServer: HttpServer;
   cleanup: () => Promise<void>;
}

/**
 * Returns true when the process should run as a stateless API only —
 * no oracle polling, no cron schedulers, no WebSocket price ticker.
 * Useful for split deployments where one process owns background work
 * and others serve HTTP, and for safer local debugging.
 */
export function isApiOnlyMode(): boolean {
   const raw = process.env.API_ONLY;
   if (!raw) return false;
   return raw.toLowerCase() === 'true';
}

/**
 * Start background services, bind to a port, and return a handle that
 * can be used to shut everything down cleanly.
 *
 * When API_ONLY=true, schedulers, oracle polling, and the WebSocket
 * price ticker are skipped. The HTTP server (and Socket.IO transport)
 * still come up, so request-driven endpoints remain available.
 */
export async function startServer(app: Express): Promise<ServerHandle> {
   const PORT = process.env.PORT || 3000;
   const httpServer = createServer(app);
   const apiOnly = isApiOnlyMode();

   // Initialize Socket.IO with JWT authentication and Redis adapter
   await initializeSocket(httpServer);

   let priceInterval: NodeJS.Timeout | null = null;

   if (apiOnly) {
      logger.info(
         'API_ONLY=true: skipping oracle polling, round scheduler, and WebSocket price ticker. Outbox poller and retention jobs still run.'
      );
      // The general scheduler (outbox poller, notification cleanup, retention)
      // must run even in API_ONLY mode so outbox events written by this process
      // are dispatched. Only oracle polling, round scheduling, and the price
      // ticker are skipped.
      schedulerService.start();
   } else {
      // Start Oracle Polling
      priceOracle.startPolling();

      // Initialize Schedulers
      schedulerService.start();
      roundSchedulerService.start();

      // Emit price updates via WebSocket
      priceInterval = setInterval(() => {
         const price = priceOracle.getPriceString();
         if (price !== null) {
            websocketService.emitPriceUpdate('XLM', price);
         }
      }, 5000);
   }

   const cleanup = async () => {
      logger.info('Shutting down gracefully...');
      if (priceInterval) {
         clearInterval(priceInterval);
      }
      if (!apiOnly) {
         priceOracle.stopPolling();
         roundSchedulerService.stop();
      }
      // Always stop the general scheduler (outbox poller, cleanup jobs)
      schedulerService.stop();
      httpServer.close();
      await prisma.$disconnect();
      logger.info('Shutdown complete');
   };

   httpServer.listen(PORT, () => {
      logger.info(`Server is running on http://localhost:${PORT}`);
      logger.info(`Socket.IO is ready for connections`);
   });

   return { httpServer, cleanup };
}

// Only start the server when this file is executed directly (not imported)
const app = createApp();

if (require.main === module) {
   (async () => {
      const { cleanup } = await startServer(app);

      process.on('SIGINT', async () => {
         await cleanup();
         process.exit(0);
      });

      process.on('SIGTERM', async () => {
         await cleanup();
         process.exit(0);
      });
   })().catch(err => {
      logger.error('Failed to start server', {
         error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
   });
}

export default app;
