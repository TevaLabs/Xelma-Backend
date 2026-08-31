import './utils/check-node-version';
import dotenv from 'dotenv';
import path from 'path';
import { createServer, Server as HttpServer } from 'http';
import { Express } from 'express';

import { assertPreflightOrExit } from './config/preflight';
import config from './config';
import { createApp as createAppFromFactory } from './app-factory';
import logger from './utils/logger';
import {
  formatBindingsReport,
  resolveBindingsPolicy,
  validateVendoredBindings,
} from './utils/bindings-validator';
import { formatResolvedSorobanConfigForLog, resolveSorobanEnvVars } from './config/env';
import priceOracle from './services/oracle';
import websocketService from './services/websocket.service';
import schedulerService from './services/scheduler.service';
import roundSchedulerService from './services/round-scheduler.service';
import oracleService from './services/oracle.service';
import { initializeSocket, closeWebSocket } from './socket';
import { prisma } from './lib/prisma';

const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile), override: false });
dotenv.config({ override: false });

export { getHttpCorsOrigins } from './utils/cors';

function validateEnv(): void {
  if (!process.env.JWT_SECRET) {
    logger.error('Application startup failed: Missing required environment variable: JWT_SECRET', {
      variable: 'JWT_SECRET',
    });
    process.exit(1);
  }
}

/**
 * Fail fast on vendored-bindings skew.
 *
 * A vendor/xelma-bindings that no longer matches bindings.pin.json means the
 * Soroban client may be calling contract methods that do not exist — a failure
 * that otherwise only surfaces on a money path under load. Deployments that
 * actually depend on Soroban refuse to boot; everything else logs an
 * actionable warning. See resolveBindingsPolicy() and docs/bindings-upgrade.md.
 */
function checkVendoredBindings(): void {
  const policy = resolveBindingsPolicy(process.env);
  if (policy === 'off') {
    logger.debug('Vendored bindings check disabled (BINDINGS_CHECK=off)');
    return;
  }

  const result = validateVendoredBindings();
  const details = {
    vendorPath: result.info.vendorPath,
    packageName: result.info.packageName,
    commitSha: result.info.commitSha,
    expectedCommitSha: result.info.expectedCommitSha,
  };

  if (result.ok) {
    logger.info('Vendored bindings OK', {
      ...details,
      contractMethodsVerified: result.info.specMethods.length,
    });
    for (const warning of result.warnings) {
      logger.warn(`Vendored bindings: ${warning}`, details);
    }
    return;
  }

  if (policy === 'strict') {
    logger.error(
      'Application startup failed: vendored @tevalabs/xelma-bindings does not match ' +
        'bindings.pin.json. Refusing to start with a possibly-mismatched contract client.',
      { ...details, errors: result.errors, remediation: result.remediation },
    );
    // Printed unstructured too: the remediation steps must survive whatever
    // log shipper the deployment uses.
    process.stderr.write(`${formatBindingsReport(result)}\n`);
    process.exit(1);
  }

  logger.warn(
    'Vendored bindings validation failed; Soroban integration may fail at runtime. ' +
      'Set BINDINGS_CHECK=strict to make this fatal.',
    { ...details, errors: result.errors, remediation: result.remediation },
  );
}

assertPreflightOrExit();
validateEnv();
checkVendoredBindings();
logger.info(`Active DATA_MODE=${config.app.dataMode}`);
logger.info(`ROUNDS_MOCK_MODE=${config.app.roundsMockMode}`);
logger.info(`Safety profile: ${config.app.safetyProfile.toUpperCase()}`);
logger.info(
  'Soroban configuration resolved',
  formatResolvedSorobanConfigForLog(resolveSorobanEnvVars(), {
    rpcUrl: config.soroban.rpcUrl,
    network: config.soroban.network,
  }),
);

const betStubMode = process.env.BET_STUB_MODE === 'true';
logger.info(`Bet mode: ${betStubMode ? 'STUB (no on-chain calls)' : 'ON-CHAIN (Soroban)'}`, {
  BET_STUB_MODE: betStubMode,
});

export function createApp(): Express {
  return createAppFromFactory({ mode: 'full' }) as Express;
}

interface ServerHandle {
  httpServer: HttpServer;
  cleanup: () => Promise<void>;
}

export function isApiOnlyMode(): boolean {
  return process.env.API_ONLY?.toLowerCase() === 'true';
}

export async function startServer(app: Express): Promise<ServerHandle> {
  const port = process.env.PORT || 3000;
  const httpServer = createServer(app);
  const apiOnly = isApiOnlyMode();

  await initializeSocket(httpServer);
  let priceInterval: NodeJS.Timeout | null = null;

  if (apiOnly) {
    logger.info('API_ONLY=true: skipping oracle polling, round scheduler, and WebSocket price ticker.');
    schedulerService.start();
  } else {
    priceOracle.startPolling();
    schedulerService.start();
    roundSchedulerService.start();
    oracleService.start();
    priceInterval = setInterval(() => {
      const price = priceOracle.getPriceString();
      if (price !== null) websocketService.emitPriceUpdate('XLM', price);
    }, 5000);
  }

  const cleanup = async (): Promise<void> => {
    if (priceInterval) clearInterval(priceInterval);
    closeWebSocket();
    if (!apiOnly) {
      priceOracle.stopPolling();
      roundSchedulerService.stop();
      oracleService.stop();
    }
    schedulerService.stop();
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await prisma.$disconnect();
  };

  httpServer.listen(port, () => logger.info(`Server is running on http://localhost:${port}`));
  return { httpServer, cleanup };
}

const app = createApp();

if (require.main === module) {
  startServer(app).catch((error) => {
    logger.error('Failed to start server', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}

export default app;
