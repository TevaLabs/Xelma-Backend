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
import { resolveBetMode } from './config/bet-mode';
import app from './app';
import logger from './utils/logger';
import { initWebSocket, closeWebSocket } from './socket';
import memoryHousekeepingService from './services/memory-housekeeping.service';

assertPreflightOrExit();
logger.info(
  'Soroban configuration resolved',
  formatResolvedSorobanConfigForLog(resolveSorobanEnvVars(), {
    rpcUrl: config.soroban.rpcUrl,
    network: config.soroban.network,
  }),
);

const betMode = resolveBetMode();
logger.info(`Bet mode: ${betMode.mode === 'stub' ? 'STUB (no on-chain calls)' : 'ON-CHAIN (Soroban)'}`, {
  mode: betMode.mode,
  source: betMode.source,
  missingSorobanConfig: betMode.missingConfig,
});
if (betMode.fellBackToStub) {
  logger.warn(
    'Required Soroban config is missing; defaulting to STUB mode. ' +
      'Bets will be recorded locally without on-chain calls. ' +
      'Set SOROBAN_CONTRACT_ID, SOROBAN_ADMIN_SECRET and SOROBAN_ORACLE_SECRET to enable on-chain bets.',
    { missingSorobanConfig: betMode.missingConfig, nodeEnv: process.env.NODE_ENV ?? 'development' },
  );
}

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

// Start lightweight in-memory retention loop to prune expired auth challenges
// and idempotency keys without running the full production scheduler.
memoryHousekeepingService.start();

httpServer.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

const shutdown = () => {
  console.log('Shutting down gracefully...');
  memoryHousekeepingService.stop();
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
