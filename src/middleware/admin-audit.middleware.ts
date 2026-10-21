import { NextFunction, Request, Response } from 'express';
import { auditLogger } from '../utils/audit-logger';

/**
 * Canonical names of privileged admin actions (Issue #497). Keep this list in
 * sync with docs/admin-rbac.md so every gated surface has an audit identity.
 */
export type AdminAction =
  | 'admin.metrics.rate_limits.read'
  | 'admin.metrics.rate_limits.clear'
  | 'admin.metrics.prometheus.read'
  | 'admin.metrics.payout_reconciliation.read'
  | 'admin.metrics.rate_limit_summary.read'
  | 'admin.cors_diagnostics.read'
  | 'admin.dead_letter.list'
  | 'admin.dead_letter.retry_all'
  | 'admin.dead_letter.retry'
  | 'admin.bet_audit.read'
  | 'admin.runtime_flags.read';

/**
 * Records the privileged action once the response has been flushed, so the
 * audit trail captures the real outcome (2xx vs 4xx/5xx). Mount it *after*
 * `requireAdmin` so unauthenticated/forbidden requests never reach it and only
 * authorized admin actions are written.
 */
export function auditAdminAction(action: AdminAction) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on('finish', () => {
      try {
        auditLogger.logAdminAction({
          action,
          outcome: res.statusCode < 400 ? 'success' : 'failure',
          walletAddress: req.user?.walletAddress,
          userId: req.user?.userId,
          requestId: req.requestId,
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          endpoint: req.originalUrl.split('?')[0],
          method: req.method,
          statusCode: res.statusCode,
        });
      } catch {
        // Auditing must never break the response path.
      }
    });

    next();
  };
}
