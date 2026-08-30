/**
 * Single owner of HTTP wiring for both entrypoints.
 *
 * The repo ships two Express applications — `src/index.ts` (full backend) and
 * `src/app.ts` (hackathon mock/demo). They used to build their middleware and
 * route stacks independently, which is why fixes kept landing in one and not
 * the other, and why route and security drift kept recurring.
 *
 * Both now call {@link createApp} and only choose a mode. Everything that
 * differs between them is expressed as a feature flag on {@link AppFeatures},
 * so the differences are enumerable in one place instead of being implied by
 * two divergent files.
 *
 * See `docs/runtime-modes.md` and CONTRIBUTING.md for the flag matrix.
 */

import express, {
  Application,
  IRouter,
  Request,
  Response,
  NextFunction,
  Router,
} from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';

import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import betsRoutes from './routes/bets.routes';
import predictionsRoutes from './routes/predictions.routes';
import educationRoutes from './routes/education.routes';
import notificationsRoutes from './routes/notifications.routes';
import chatRoutes from './routes/chat.routes';
import tournamentsRoutes from './routes/tournaments.routes';
import metricsRoutes from './routes/metrics.routes';
import adminMetricsRoutes from './routes/admin-metrics.routes';
import errorsRoutes from './routes/errors.routes';
import corsDiagnosticsRoutes from './routes/admin-cors-diagnostics.routes';
import deadLetterRoutes from './routes/admin-dead-letter.routes';
import betAuditRoutes from './routes/admin-bet-audit.routes';
import healthRoutes from './routes/health';
import statsRoutes from './routes/stats';
import indexRoutes from './routes/index';
import pricesRoutes, { legacyXlmPriceRouter } from './routes/prices';

// The two entrypoints deliberately serve different round and leaderboard
// surfaces: the full app exposes the production routers, the hackathon app
// exposes the mock/demo ones. Both are mounted through this factory so the
// choice is explicit rather than implied by which file you happen to read.
// Rounds are no longer mode-specific: #389 consolidated `routes/rounds.ts` and
// `routes/round.routes.ts` into this single router, which both modes mount.
import roundsRoutes from './routes/rounds.routes';
import fullLeaderboardRoutes from './routes/leaderboard.routes';
import hackathonLeaderboardRoutes from './routes/leaderboard';

import { apiRateLimiter, writeRateLimiter } from './middleware/rateLimiter.middleware';
import { requestIdMiddleware } from './middleware/requestId.middleware';
import { metricsMiddleware } from './middleware/metrics.middleware';
import { httpLoggerMiddleware } from './middleware/httpLogger.middleware';
import { tracingMiddleware } from './middleware/tracing.middleware';
import { securityHeadersMiddleware } from './middleware/securityHeaders.middleware';
import { notFoundHandler } from './middleware/notFound';
import { errorHandler as hackathonErrorHandler } from './middleware/errorHandler';
import { errorHandler as fullErrorHandler } from './middleware/errorHandler.middleware';
import { getHttpCorsOrigins } from './utils/cors';
import { swaggerSpec } from './docs/openapi';
import { hackathonSwaggerSpec } from './docs/hackathon-openapi';
import config from './config';
import logger from './utils/logger';

export type AppMode = 'full' | 'hackathon';

/**
 * Every surface that differs between the two entrypoints.
 *
 * Anything listed here is mounted by exactly one of the two modes by default.
 * Adding a route that only one app should serve means adding a flag here —
 * that is what keeps `route-parity.spec.ts` meaningful.
 */
export interface AppFeatures {
  /** Wallet challenge/connect auth flow. `/api/auth/*` */
  auth: boolean;
  /** Authenticated prediction submission and history. `/api/predictions/*` */
  predictions: boolean;
  /** Education guides and tips. `/api/education/*` */
  education: boolean;
  /** Machine-readable error catalog. `/api/errors` */
  errorCatalog: boolean;
  /** Admin surfaces: metrics, CORS diagnostics, dead-letter queue, bet audit. */
  adminRoutes: boolean;
  /** Mirror every `/api/*` route under `/api/v1/*`. */
  versionedAlias: boolean;
  /** Emit Deprecation/Sunset headers on unversioned `/api/*` paths. */
  deprecationHeaders: boolean;
  /** Apply the global read/write rate limiters to all of `/api`. */
  globalApiRateLimit: boolean;
  /** Landing-page platform stats. `/api/stats` */
  platformStats: boolean;
  /** Chat and notifications. Also gated by ENABLE_MULTIPLAYER_SOCIAL. */
  multiplayerSocial: boolean;
  /** Legacy single-asset XLM price endpoint. `GET /api/price` */
  legacyPriceEndpoint: boolean;
  /** Root welcome banner. `GET /` */
  rootBanner: boolean;
  /** Swagger UI and the spec it serves. */
  apiDocs: boolean;
}

export interface CreateAppOptions {
  /**
   * Which entrypoint is being built. Selects the default feature set, the
   * security middleware, the round/leaderboard routers, the OpenAPI spec,
   * and the error handler.
   */
  mode?: AppMode;
  /** Per-flag overrides on top of the mode defaults. Mainly for tests. */
  features?: Partial<AppFeatures>;
  /**
   * Register the 404 and error handlers. Off when the caller wants to append
   * its own routes after the factory returns.
   */
  includeErrorHandlers?: boolean;
}

/**
 * Full backend (`npm run dev`, `src/index.ts`). Serves every surface.
 */
const FULL_FEATURES: AppFeatures = {
  auth: true,
  predictions: true,
  education: true,
  errorCatalog: true,
  adminRoutes: true,
  versionedAlias: true,
  deprecationHeaders: true,
  globalApiRateLimit: false,
  platformStats: false,
  multiplayerSocial: true,
  legacyPriceEndpoint: true,
  rootBanner: true,
  apiDocs: true,
};

/**
 * Hackathon mock/demo app (`npm run dev:hackathon`, `src/app.ts`).
 *
 * Wallet auth is shared with the full app so clients can obtain JWTs without
 * switching servers (#400). No predictions/education/admin surface. Rate
 * limiting is applied globally instead of per-route.
 */
const HACKATHON_FEATURES: AppFeatures = {
  auth: true,
  predictions: false,
  education: false,
  errorCatalog: false,
  adminRoutes: false,
  versionedAlias: false,
  deprecationHeaders: false,
  globalApiRateLimit: true,
  platformStats: true,
  multiplayerSocial: true,
  legacyPriceEndpoint: false,
  rootBanner: false,
  apiDocs: true,
};

export function resolveFeatures(
  mode: AppMode,
  overrides: Partial<AppFeatures> = {},
): AppFeatures {
  const base = mode === 'full' ? FULL_FEATURES : HACKATHON_FEATURES;
  const resolved: AppFeatures = { ...base, ...overrides };

  // ENABLE_MULTIPLAYER_SOCIAL can switch chat/notifications off in either
  // mode; an explicit override still wins so tests can force the surface on.
  if (overrides.multiplayerSocial === undefined) {
    resolved.multiplayerSocial =
      resolved.multiplayerSocial && config.app.enableMultiplayerSocial;
  }

  return resolved;
}

function mountBaseMiddleware(app: Application, mode: AppMode): void {
  // One helmet configuration for both modes — the shared middleware pins the
  // explicit CSP, frameguard, Referrer-Policy, legacy X-XSS-Protection and
  // Permissions-Policy that helmet's defaults do not set (Issue #414/#480).
  app.use(securityHeadersMiddleware);

  app.use(express.json());
  if (mode === 'full') {
    app.use(express.urlencoded({ extended: true }));
  }

  app.use(
    cors({
      origin: getHttpCorsOrigins(),
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
      credentials: true,
    }),
  );

  // Correlation ID first, so everything downstream can log it.
  app.use(requestIdMiddleware);
  app.use(metricsMiddleware);
  app.use(tracingMiddleware);
  // Both modes log the same shape (method, path, status, durationMs,
  // requestId) on response finish — see src/middleware/httpLogger.middleware.ts
  // and src/tests/http-logger-unified.spec.ts (Issue #423).
  app.use(httpLoggerMiddleware);
}

function mountApiDocs(app: Application, mode: AppMode): void {
  const spec = mode === 'full' ? swaggerSpec : hackathonSwaggerSpec;

  app.get('/docs', (_req: Request, res: Response) => res.redirect(302, '/api-docs'));
  app.get('/api-docs.json', (_req: Request, res: Response) => res.json(spec));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(spec, { explorer: true }));
}

/**
 * Mount the routers shared by both entrypoints plus the flag-gated ones.
 *
 * `prefix` is `/api` for the primary mount and `/api/v1` for the versioned
 * alias, which is why this is a function rather than an inline block: the
 * alias must stay a mirror, and a single body is the only way to guarantee it.
 */
function mountApiRoutes(
  target: IRouter,
  mode: AppMode,
  features: AppFeatures,
): void {
  if (features.auth) {
    target.use('/auth', authRoutes);
  }

  target.use('/user', userRoutes);
  target.use('/rounds', roundsRoutes);
  target.use('/bets', betsRoutes);

  if (features.predictions) {
    target.use('/predictions', predictionsRoutes);
  }
  if (features.education) {
    target.use('/education', educationRoutes);
  }

  target.use(
    '/leaderboard',
    mode === 'full' ? fullLeaderboardRoutes : hackathonLeaderboardRoutes,
  );

  if (features.multiplayerSocial) {
    target.use('/chat', chatRoutes);
    target.use('/notifications', notificationsRoutes);
  }

  target.use('/tournaments', tournamentsRoutes);

  if (features.platformStats) {
    target.use('/stats', statsRoutes);
  }

  if (features.adminRoutes) {
    target.use('/admin/metrics', adminMetricsRoutes);
    target.use('/admin/cors-diagnostics', corsDiagnosticsRoutes);
    target.use('/admin/dead-letter', deadLetterRoutes);
    target.use('/admin/bet-audit', betAuditRoutes);
  }

  if (features.errorCatalog) {
    target.use('/errors', errorsRoutes);
  }

  // Multi-asset price ticker. Defines its own `/prices` path, so it mounts at
  // the API root rather than under a prefix. The two modes serve different
  // response shapes (raw snapshot vs. success envelope), so the router is
  // mode-specific like rounds and leaderboard above.
  target.use('/', mode === 'full' ? pricesRoutes : indexRoutes);

  if (features.legacyPriceEndpoint) {
    target.use('/', legacyXlmPriceRouter);
  }
}

/**
 * Build an Express application.
 *
 * Neither background jobs nor a listening socket are started here — that is
 * `startServer`'s job — so this is safe to import from tests.
 */
export function createApp(options: CreateAppOptions = {}): Application {
  const { mode = 'full', includeErrorHandlers = true } = options;
  const features = resolveFeatures(mode, options.features);

  const app: Application = express();

  mountBaseMiddleware(app, mode);

  if (mode === 'hackathon') {
    // The hackathon app documents itself before serving anything, and rate
    // limits all of /api rather than individual mutating routes.
    if (features.apiDocs) {
      mountApiDocs(app, mode);
    }
    app.use('/metrics', metricsRoutes);
  }

  if (features.globalApiRateLimit) {
    app.use('/api', apiRateLimiter);
    app.use('/api', writeRateLimiter);
  }

  // Health probe. The full app serves it off the API prefix so uptime checks
  // are neither rate limited nor versioned; the hackathon app keeps it under
  // /api, where it also answers the bare `GET /api` readiness call.
  if (mode === 'full') {
    app.use('/health', healthRoutes);
  }

  // The versioned alias is registered first so `/api/v1/*` resolves there
  // rather than falling through the unversioned router.
  if (features.versionedAlias) {
    const v1Router = Router();
    mountApiRoutes(v1Router, mode, features);
    app.use('/api/v1', v1Router);
  }

  if (features.deprecationHeaders) {
    app.use('/api', (req: Request, res: Response, next: NextFunction) => {
      if (!req.path.startsWith('/v1')) {
        res.setHeader('Deprecation', 'true');
        res.setHeader('Sunset', 'Sat, 01 Jan 2027 00:00:00 GMT');
        res.setHeader('Link', `</api/v1${req.path}>; rel="successor-version"`);
      }
      next();
    });
  }

  const apiRouter = Router();
  if (mode === 'hackathon') {
    apiRouter.use('/', healthRoutes);
  }
  mountApiRoutes(apiRouter, mode, features);
  app.use('/api', apiRouter);

  if (mode === 'full') {
    app.use('/metrics', metricsRoutes);

    if (features.apiDocs) {
      mountApiDocs(app, mode);
    }

    if (features.rootBanner) {
      app.get('/', (_req: Request, res: Response) => {
        res.json({
          message: 'Hello World! Xelma Backend is running',
          timestamp: new Date().toISOString(),
          status: 'OK',
        });
      });
    }
  }

  if (includeErrorHandlers) {
    if (mode === 'full') {
      // Forward unmatched routes into the error handler so 404s use the same
      // response envelope as every other error.
      app.use((req: Request, _res: Response, next: NextFunction) => {
        const { NotFoundError } = require('./utils/errors');
        next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
      });
      app.use(fullErrorHandler);
    } else {
      app.use(notFoundHandler);
      app.use(hackathonErrorHandler);
    }
  }

  return app;
}

export default createApp;
