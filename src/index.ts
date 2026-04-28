import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer, Server as HttpServer } from 'http';
import authRoutes from './routes/auth.routes';
import userRoutes from "./routes/user.routes";
import roundsRoutes from './routes/rounds.routes';
import predictionsRoutes from './routes/predictions.routes';
import educationRoutes from './routes/education.routes';
import leaderboardRoutes from './routes/leaderboard.routes';
import notificationsRoutes from "./routes/notifications.routes";
import priceOracle from './services/oracle';
import sorobanService from './services/soroban.service';
import websocketService from './services/websocket.service';
import schedulerService from './services/scheduler.service';
import roundSchedulerService from './services/round-scheduler.service';
import logger from './utils/logger';
import { errorHandler } from './middleware/errorHandler.middleware';
import { metricsMiddleware } from './middleware/metrics.middleware';
import { requestIdMiddleware } from './middleware/requestId.middleware';
import metricsRoutes from './routes/metrics.routes';
import adminMetricsRoutes from './routes/admin-metrics.routes';
import chatRoutes from "./routes/chat.routes";
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './docs/openapi';
import { initializeSocket } from './socket';
import { prisma } from './lib/prisma';
import path from 'path';

const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile), override: false });
dotenv.config({ override: false });


const validateEnv = (): void => {
  if (!process.env.JWT_SECRET) {
    console.error('🔥 CRITICAL ERROR: Application startup failed.');
    console.error('Missing required environment variable: JWT_SECRET');
    console.error('Please configure this securely in your environment before starting the app.');
    process.exit(1); // 1 indicates a failure/error state
  }
};

// Execute validation immediately
validateEnv();

/**
 * Create and configure the Express app without starting any background
 * jobs or binding to a network port. Safe to import in tests.
 */
export function createApp(): Express {
  const app = express();

  // Middleware
  app.use(cors());
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
  app.use("/api/auth", authRoutes);
  app.use("/api/user", userRoutes);
  app.use("/api/rounds", roundsRoutes);
  app.use("/api/predictions", predictionsRoutes);
  app.use("/api/education", educationRoutes);
  app.use("/api/leaderboard", leaderboardRoutes);
  app.use("/api/chat", chatRoutes);
  app.use("/api/notifications", notificationsRoutes);
  app.use("/api/admin/metrics", adminMetricsRoutes);

  // Prometheus metrics endpoint
  app.use('/metrics', metricsRoutes);

  // Swagger UI (OpenAPI)
  app.get('/docs', (req: Request, res: Response) => res.redirect(302, '/api-docs'));
  app.get('/api-docs.json', (req: Request, res: Response) => res.json(swaggerSpec));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, { explorer: true }));

  // Hello World endpoint
  app.get("/", (req: Request, res: Response) => {
    res.json({
      message: "Hello World! Xelma Backend is running",
      timestamp: new Date().toISOString(),
      status: "OK",
    });
  });

  // Health check endpoint
  app.get("/health", async (req: Request, res: Response) => {
    const startTime = Date.now();
    let dbStatus = "unhealthy";
    let dbDurationMs = 0;
    let overallStatus = "healthy";

    // Check database connectivity with bounded timeout
    try {
      const dbCheckStart = Date.now();
      await Promise.race([
        prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("DB health check timeout")), 5000)
        ),
      ]);
      dbStatus = "healthy";
      dbDurationMs = Date.now() - dbCheckStart;
      logger.debug("Database health check passed", { dbDurationMs });
    } catch (dbError: any) {
      dbStatus = "unhealthy";
      dbDurationMs = Date.now() - startTime;
      overallStatus = "degraded";
      logger.warn("Database health check failed", {
        error: dbError?.message || "Unknown error",
        dbDurationMs,
      });
    }

    // Check Soroban service health
    let sorobanHealth;
    try {
      sorobanHealth = await sorobanService.getHealth();
    } catch (error: any) {
      logger.warn("Soroban health check failed", { error: error?.message });
      sorobanHealth = { initialized: false, error: "Health check failed" };
    }

    const responseCode = overallStatus === "healthy" ? 200 : 503;
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
  app.get("/api/price", (req: Request, res: Response) => {
    const price = priceOracle.getPriceString();
    const lastUpdatedAt = priceOracle.getLastUpdatedAt();
    res.json({
      asset: "XLM",
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
 * Start background services, bind to a port, and return a handle that
 * can be used to shut everything down cleanly.
 */
export function startServer(app: Express): ServerHandle {
  const PORT = process.env.PORT || 3000;
  const httpServer = createServer(app);

  // Initialize Socket.IO with JWT authentication
  initializeSocket(httpServer);

  // Start Oracle Polling
  priceOracle.startPolling();

  // Initialize Schedulers
  schedulerService.start();
  roundSchedulerService.start();

  // Emit price updates via WebSocket
  const priceInterval = setInterval(() => {
    const price = priceOracle.getPriceString();
    if (price !== null) {
      websocketService.emitPriceUpdate("XLM", price);
    }
  }, 5000);

  const cleanup = async () => {
    logger.info("Shutting down gracefully...");
    clearInterval(priceInterval);
    priceOracle.stopPolling();
    schedulerService.stop();
    roundSchedulerService.stop();
    httpServer.close();
    await prisma.$disconnect();
    logger.info("Shutdown complete");
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
  const { cleanup } = startServer(app);

  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });
}

export default app;
