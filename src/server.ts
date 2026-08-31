/**
 * Hackathon server (`npm run dev:hackathon`).
 *
 * Chooses the mode and owns the process lifecycle; all HTTP wiring comes from
 * `src/app-factory.ts` via `src/app.ts`.
 */
import dotenv from 'dotenv';
import { createServer } from 'http';

dotenv.config();

import { assertPreflightOrExit } from './config/preflight';
import config from './config';
import {
  formatResolvedSorobanConfigForLog,
  resolveSorobanEnvVars,
} from './config/env';
import app from './app';
import logger from './utils/logger';
import { initWebSocket, closeWebSocket } from './socket';

assertPreflightOrExit();
logger.info(
  'Soroban configuration resolved',
  formatResolvedSorobanConfigForLog(resolveSorobanEnvVars(), {
    rpcUrl: config.soroban.rpcUrl,
    network: config.soroban.network,
  }),
);

const PORT = process.env.PORT || 3001;
const httpServer = createServer(app);

if (config.app.socketDemoMode) {
  logger.info(
    'Socket demo mode enabled (SOCKET_DEMO_MODE / mock data store): price and round rooms work without Prisma chat',
  );
}

initWebSocket(httpServer).catch(error => {
  logger.error('WebSocket initialization failed', { error: (error as Error).message });
  process.exit(1);
});

httpServer.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

const shutdown = () => {
  console.log('Shutting down gracefully...');
  closeWebSocket();
  // Ensure we don't hang on HTTP keep-alive connections
  httpServer.closeAllConnections();
  httpServer.close(() => {
    console.log('Shutdown complete');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
