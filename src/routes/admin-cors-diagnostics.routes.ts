import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.middleware';
import { getCorsOrigins, getSocketCorsConfig, parseOriginList, CorsOriginConfig } from '../utils/cors';

const router = Router();

/**
 * @openapi
 * /api/admin/cors-diagnostics:
 *   get:
 *     summary: Resolved CORS origin allowlist for HTTP and Socket.IO
 *     description: |
 *       Returns the effective CORS configuration that this process is
 *       enforcing right now, so operators can debug origin-mismatch
 *       errors against frontends without needing shell access.
 *       Admin only. Exposes only the resolved allowlist plus the
 *       config-shaping env vars (`NODE_ENV`, `CLIENT_URL`,
 *       `ALLOWED_ORIGINS`). No secrets are returned, and an optional
 *       `?origin=` query parameter reports whether that origin would
 *       be accepted.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: origin
 *         schema:
 *           type: string
 *         description: An origin to test against the resolved allowlist.
 *     responses:
 *       200:
 *         description: Resolved CORS configuration
 */
router.get('/', requireAdmin, (req: Request, res: Response) => {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const clientUrl = process.env.CLIENT_URL ?? null;
  const allowedOrigins = parseOriginList(process.env.ALLOWED_ORIGINS);

  const normalize = (
    resolved: CorsOriginConfig,
  ): { allowAll: boolean; origins: string[] } => {
    if (resolved === true || resolved === '*') {
      return { allowAll: true, origins: [] };
    }
    if (Array.isArray(resolved)) {
      return { allowAll: false, origins: resolved };
    }
    if (typeof resolved === 'string') {
      return { allowAll: false, origins: [resolved] };
    }
    return { allowAll: false, origins: [] };
  };

  let httpResolved: { allowAll: boolean; origins: string[]; error?: string };
  try {
    httpResolved = normalize(getCorsOrigins());
  } catch (e) {
    httpResolved = { allowAll: false, origins: [], error: (e as Error).message };
  }

  let socketResolved: {
    allowAll: boolean;
    origins: string[];
    methods: string[];
    credentials: boolean;
    error?: string;
  };
  try {
    const socketConfig = getSocketCorsConfig();
    const normalized = normalize(socketConfig.origin);
    socketResolved = {
      ...normalized,
      methods: socketConfig.methods,
      credentials: socketConfig.credentials,
    };
  } catch (e) {
    socketResolved = {
      allowAll: false,
      origins: [],
      methods: ['GET', 'POST'],
      credentials: true,
      error: (e as Error).message,
    };
  }

  const http = httpResolved;
  const socket = socketResolved;

  const testOrigin =
    typeof req.query.origin === 'string' ? req.query.origin : null;

  const matches = (origins: string[], allowAll: boolean): boolean | null => {
    if (testOrigin === null) return null;
    if (allowAll) return true;
    return origins.includes(testOrigin);
  };

  res.json({
    env: {
      nodeEnv,
      clientUrl,
      allowedOrigins,
    },
    http,
    socket,
    test: testOrigin
      ? {
          origin: testOrigin,
          httpAllowed: matches(http.origins, http.allowAll),
          socketAllowed: matches(socket.origins, socket.allowAll),
        }
      : null,
  });
});

export default router;
