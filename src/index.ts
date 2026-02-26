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
import websocketService from './services/websocket.service';
import schedulerService from './services/scheduler.service';
import roundSchedulerService from './services/round-scheduler.service';
import logger from './utils/logger';
import chatRoutes from "./routes/chat.routes";
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './docs/openapi';
import { initializeSocket } from './socket';
import { prisma } from './lib/prisma';

dotenv.config();


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

  // Request logging middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    logger.info(`${req.method} ${req.path}`);
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
  app.get("/health", (req: Request, res: Response) => {
    res.json({
      status: "healthy",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // Price Oracle endpoint
  app.get("/api/price", (req: Request, res: Response) => {
    const price = priceOracle.getPrice();
    const lastUpdatedAt = priceOracle.getLastUpdatedAt();
    res.json({
      asset: "XLM",
      price_usd: price,
      stale: priceOracle.isStale(),
      lastUpdatedAt: lastUpdatedAt?.toISOString() ?? null,
      timestamp: new Date().toISOString(),
    });
  });

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: "Not Found",
      message: `Route ${req.method} ${req.path} not found`,
    });
  });

  // Global error handler
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    logger.error("Error:", err);
    res.status(500).json({
      error: "Internal Server Error",
      message: err.message,
      ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
    });
  });

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
    const price = priceOracle.getPrice();
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
