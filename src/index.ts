const nodeMajorVersion = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajorVersion < 22 && process.env.NODE_ENV !== 'test') {
  logger.error('Application startup failed: Node.js v22.x or higher is required', {
    nodeVersion: process.version,
    hint: 'Upgrade Node.js to avoid local vs Render mismatches.',
  });
  process.exit(1);
}

import { Express } from 'express';
import dotenv from 'dotenv';
import { assertPreflightOrExit } from './config/preflight';
import { createServer, Server as HttpServer } from 'http';
import priceOracle from './services/oracle';
import websocketService from './services/websocket.service';
import schedulerService from './services/scheduler.service';
import roundSchedulerService from './services/round-scheduler.service';
import oracleService from './services/oracle.service';
import logger from './utils/logger';
import {
  validateVendoredBindingsSync,
  validateVendoredBindings,
} from './utils/bindings-validator';
import config from './config';
import { createApp as createAppFromFactory, AppFeatures } from './app-factory';
import {
  formatResolvedSorobanConfigForLog,
  resolveSorobanEnvVars,
} from './config/env';
import { initializeSocket, closeWebSocket } from './socket';
import { prisma } from './lib/prisma';
import path from 'path';

const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile), override: false });
dotenv.config({ override: false });

export { getHttpCorsOrigins } from './utils/cors';

const validateEnv = (): void => {
   if (!process.env.JWT_SECRET) {
      logger.error('Application startup failed: Missing required environment variable: JWT_SECRET', {
         variable: 'JWT_SECRET',
      });
      logger.error('Please configure this securely in your environment before starting the app.');
      process.exit(1);
   }
};

function logRemediation(): string {
   return [
      'Remediation steps:',
      '  1. Run `npm run install-bindings` to fetch the latest bindings.',
      '  2. If the contract ABI changed, update .bindings-metadata.json with the new SHA and required surface.',
      '  3. Run `npm run prisma:generate && npm run build` to rebuild.',
      '  See BINDINGS_UPGRADE.md for the full procedure.',
   ].join('\n');
}

/**
 * Synchronous structural validation — runs immediately at startup.
 * Logs warnings for missing files or wrong package name.
 */
function logBindingsStructuralValidation(): void {
   const result = validateVendoredBindingsSync();
   if (result.ok) {
      logger.info('Vendored bindings structural check OK', {
         vendorPath: result.info.vendorPath,
         packageName: result.info.packageName,
         commitSha: result.info.commitSha,
      });
   } else {
      logger.warn(
         'Vendored bindings structural validation failed; Soroban integration may fail at runtime',
         {
            vendorPath: result.info.vendorPath,
            errors: result.errors,
            commitSha: result.info.commitSha,
         },
      );
   }
}

/**
 * Async API surface validation — runs during startup to verify that the
 * vendored Client class exposes all methods the Soroban service depends on.
 * Catches version skew before the first Soroban call.
 */
async function logBindingsSurfaceValidation(): Promise<void> {
   const result = await validateVendoredBindings();
   if (result.ok) {
      logger.info('Vendored bindings surface check OK', {
         commitSha: result.info.commitSha,
      });
      return;
   }

   const isSkew = result.info.shaMatch === false ||
      result.info.missingMethods.length > 0 ||
      result.info.missingExports.length > 0;

   const remediation = logRemediation();

   if (isSkew) {
      logger.error(
         'Vendored bindings version skew detected — the Soroban client will likely fail at runtime',
         {
            errors: result.errors,
            commitSha: result.info.commitSha,
            expectedCommitSha: result.info.expectedCommitSha,
            shaMatch: result.info.shaMatch,
            missingMethods: result.info.missingMethods,
            missingExports: result.info.missingExports,
            remediation,
         },
      );

      if (process.env.FAIL_ON_BINDINGS_MISMATCH === 'true') {
         logger.error('FAIL_ON_BINDINGS_MISMATCH=true — aborting startup due to bindings skew');
         process.exit(1);
      }
   } else {
      logger.warn(
         'Vendored bindings surface validation failed; Soroban integration may fail at runtime',
         {
            errors: result.errors,
            commitSha: result.info.commitSha,
            remediation,
         },
      );
   }
}

// Run preflight gate before anything else initializes
assertPreflightOrExit();

// Execute structural validation immediately (sync)
validateEnv();
logBindingsStructuralValidation();
logger.info(`Active DATA_MODE=${config.app.dataMode}`);
logger.info(`ROUNDS_MOCK_MODE=${config.app.roundsMockMode}`);
logger.info(
  'Soroban configuration resolved',
  formatResolvedSorobanConfigForLog(resolveSorobanEnvVars(), {
    rpcUrl: config.soroban.rpcUrl,
    network: config.soroban.network,
  }),
);

const betStubMode = process.env.BET_STUB_MODE === "true";
logger.info(`Bet mode: ${betStubMode ? "STUB (no on-chain calls)" : "ON-CHAIN (Soroban)"}`, {
  BET_STUB_MODE: betStubMode,
});
logger.info(
  `Soroban money-path policy: ${config.soroban.failClosed ? "FAIL-CLOSED (abort on chain failure)" : "FAIL-OPEN (DB-only fallback allowed)"}`,
  { SOROBAN_FAIL_CLOSED: config.soroban.failClosed },
);
logger.info('Runtime modes documented at docs/runtime-modes.md');

/**
 * Create and configure the Express app without starting any background
 * jobs or binding to a network port. Safe to import in tests.
 *
 * HTTP wiring lives in `src/app-factory.ts` and is shared with the hackathon
 * entrypoint; this only selects the full feature set. See CONTRIBUTING.md for
 * the flag matrix.
 */
export function createApp(features?: Partial<AppFeatures>): Express {
   return createAppFromFactory({ mode: 'full', features }) as Express;
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
      schedulerService.start();
   } else {
      priceOracle.startPolling();
      schedulerService.start();
      roundSchedulerService.start();
      oracleService.start();

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
      closeWebSocket();
      if (!apiOnly) {
         priceOracle.stopPolling();
         roundSchedulerService.stop();
         oracleService.stop();
      }
      schedulerService.stop();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => {
         httpServer.close(() => resolve());
      });
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
      // Run async surface validation before starting the server
      await logBindingsSurfaceValidation();

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
