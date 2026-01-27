import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Server } from 'socket.io';
import { createServer } from 'http';
import authRoutes from './routes/auth.routes';
import roundsRoutes from './routes/rounds.routes';
import predictionsRoutes from './routes/predictions.routes';
import educationRoutes from './routes/education.routes';
import leaderboardRoutes from './routes/leaderboard.routes';
import priceOracle from './services/oracle';
import websocketService from './services/websocket.service';
import schedulerService from './services/scheduler.service';
import logger from './utils/logger';

dotenv.config();

const app: Express = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

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
app.use('/api/auth', authRoutes);
app.use('/api/rounds', roundsRoutes);
app.use('/api/predictions', predictionsRoutes);
app.use('/api/education', educationRoutes);
app.use('/api/leaderboard', leaderboardRoutes);

// Hello World endpoint
app.get('/', (req: Request, res: Response) => {
  res.json({
    message: 'Hello World! Xelma Backend is running',
    timestamp: new Date().toISOString(),
    status: 'OK'
  });
});

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Price Oracle endpoint
app.get('/api/price', (req: Request, res: Response) => {
  const price = priceOracle.getPrice();
  res.json({
    asset: 'XLM',
    price_usd: price,
    timestamp: new Date().toISOString()
  });
});

// Start Oracle Polling
priceOracle.startPolling();

// Initialize WebSocket service
websocketService.initialize(io);

// Initialize Scheduler
schedulerService.start();

// Emit price updates via WebSocket
setInterval(() => {
  const price = priceOracle.getPrice();
  if (price !== null) {
    websocketService.emitPriceUpdate('XLM', price);
  }
}, 5000); // Every 5 seconds

// Socket.IO connection handler
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);

  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`
  });
});

// Global error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('Error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Start server
httpServer.listen(PORT, () => {
  logger.info(`🚀 Server is running on http://localhost:${PORT}`);
  logger.info(`📡 Socket.IO is ready for connections`);
});
