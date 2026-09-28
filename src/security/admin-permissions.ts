import { UserRole } from "@prisma/client";

/**
 * Admin RBAC matrix (Issue #497).
 *
 * Admin surfaces are powerful — DLQ replay, CORS diagnostics, bet-audit
 * queries and rate-limit controls. Historically each route inlined a bare
 * `requireAdmin`, which made it impossible to say *what* an admin is allowed
 * to do and easy to add a privileged route without a corresponding audit.
 *
 * This module is the single source of truth: a role maps to a set of
 * {@link AdminPermission}s, and every privileged route declares the
 * permission it needs. The human-readable table lives in
 * [docs/rbac.md](../../docs/rbac.md); keep the two in sync.
 *
 * Scope note: these permissions gate the `/api/admin/*` operator surface only.
 * Non-admin privileged routes (`POST /api/rounds/start`, oracle settlement,
 * …) continue to use the role-level `requireAdmin` / `requireOracle`
 * middleware in `src/middleware/auth.middleware.ts`.
 */
export enum AdminPermission {
  /** Read rate-limit activity and Prometheus-backed summaries. */
  METRICS_READ = "admin.metrics.read",
  /** Destructive rate-limit housekeeping (`/rate-limits/clear`). */
  METRICS_WRITE = "admin.metrics.write",
  /** Read the resolved CORS allowlist for HTTP and Socket.IO. */
  CORS_DIAGNOSTICS_READ = "admin.cors.diagnostics.read",
  /** Read the dead-letter queue. */
  DLQ_READ = "admin.dlq.read",
  /** Replay dead-letter entries (single or bulk). */
  DLQ_REPLAY = "admin.dlq.replay",
  /** Query the bet-audit event trail. */
  BET_AUDIT_READ = "admin.bet.audit.read",
  /** Read the payout-reconciliation ledger summary. */
  PAYOUT_RECONCILIATION_READ = "admin.payout.reconciliation.read",
}

/**
 * Every permission in {@link AdminPermission}, used as the ADMIN grant set.
 * Kept explicit (rather than `Object.values`) so a new permission cannot be
 * silently granted to ADMIN without also appearing in the matrix and docs.
 */
export const ALL_ADMIN_PERMISSIONS: readonly AdminPermission[] = Object.freeze([
  AdminPermission.METRICS_READ,
  AdminPermission.METRICS_WRITE,
  AdminPermission.CORS_DIAGNOSTICS_READ,
  AdminPermission.DLQ_READ,
  AdminPermission.DLQ_REPLAY,
  AdminPermission.BET_AUDIT_READ,
  AdminPermission.PAYOUT_RECONCILIATION_READ,
]);

/**
 * The canonical role → permission matrix.
 *
 * USER and ORACLE hold no admin permissions — the operator surface is
 * ADMIN-only. ORACLE's authority is limited to round settlement, expressed
 * via `ORACLE_ALLOWED_ROLES` in the route-auth registry, not here.
 */
export const ADMIN_ROLE_PERMISSIONS: Readonly<
  Record<UserRole, readonly AdminPermission[]>
> = Object.freeze({
  [UserRole.USER]: Object.freeze([] as AdminPermission[]),
  [UserRole.ORACLE]: Object.freeze([] as AdminPermission[]),
  [UserRole.ADMIN]: ALL_ADMIN_PERMISSIONS,
});

/**
 * Resolve the admin permissions granted to a role.
 *
 * Unknown/undefined roles (e.g. a JWT claiming a role the client does not
 * know about) fail closed and receive no permissions.
 */
export function getAdminPermissions(
  role: UserRole | string | null | undefined,
): readonly AdminPermission[] {
  if (!role) return [];
  return ADMIN_ROLE_PERMISSIONS[role as UserRole] ?? [];
}

/**
 * True when `role` holds `permission` under the matrix. Fails closed for
 * unknown roles.
 */
export function roleHasAdminPermission(
  role: UserRole | string | null | undefined,
  permission: AdminPermission,
): boolean {
  return getAdminPermissions(role).includes(permission);
}

/**
 * True when the role can reach the admin surface at all. Used by tests and
 * by the hackathon-mode guard to assert admin stays off unless granted.
 */
export function isAdminRole(role: UserRole | string | null | undefined): boolean {
  return getAdminPermissions(role).length > 0;
}

/** Stable, sorted list of every permission — handy for docs and tests. */
export function listAdminPermissions(): AdminPermission[] {
  return [...ALL_ADMIN_PERMISSIONS];
}
