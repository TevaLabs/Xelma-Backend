import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.middleware';
import { getHttpCorsOrigins } from '../utils/cors';
import { getCorsOrigins as getSocketCorsOrigins } from '../socket';

const router = Router();

/**
 * @openapi
 * /admin/cors-diagnostics:
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
  const allowedOriginsRaw = process.env.ALLOWED_ORIGINS ?? null;
  const allowedOrigins = allowedOriginsRaw
    ? allowedOriginsRaw.split(',').map((o) => o.trim()).filter(Boolean)
    : [];

  let http: { allowAll: boolean; origins: string[]; error?: string };
  try {
    const resolved = getHttpCorsOrigins();
    if (resolved === true) {
      http = { allowAll: true, origins: [] };
    } else if (Array.isArray(resolved)) {
      http = { allowAll: false, origins: resolved };
    } else if (typeof resolved === 'string') {
      http = { allowAll: false, origins: [resolved] };
    } else {
      http = { allowAll: false, origins: [] };
    }
  } catch (e) {
    http = { allowAll: false, origins: [], error: (e as Error).message };
  }

  let socket: { allowAll: boolean; origins: string[]; error?: string };
  try {
    const resolved = getSocketCorsOrigins();
    if (resolved === '*') {
      socket = { allowAll: true, origins: [] };
    } else if (Array.isArray(resolved)) {
      socket = { allowAll: false, origins: resolved };
    } else {
      socket = { allowAll: false, origins: [resolved] };
    }
  } catch (e) {
    socket = { allowAll: false, origins: [], error: (e as Error).message };
  }

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
