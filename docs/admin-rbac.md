# Admin RBAC matrix and audit log (Issue #497)

All privileged surfaces are gated by `requireAdmin`
(`src/middleware/auth.middleware.ts`), which verifies the JWT and then loads
the caller's role from the database, so a token cannot claim admin by itself.
Requests that fail authentication return `401`; authenticated non-admin users
return `403`.

## Roles

| Role | Capabilities |
| --- | --- |
| `USER` | Public + authenticated routes only (bets, predictions, notifications, leaderboard). No admin surface. |
| `ORACLE` | `USER` capabilities plus `POST /api/rounds/:id/resolve`. |
| `ADMIN` | Everything in `USER`/`ORACLE` plus every route below. |

## Admin route matrix

Registry source of truth: [`src/security/route-auth.registry.ts`](../src/security/route-auth.registry.ts).
Audit action names are declared in
[`src/middleware/admin-audit.middleware.ts`](../src/middleware/admin-audit.middleware.ts).

| Route | Minimum role | Audit action | Notes |
| --- | --- | --- | --- |
| `POST /api/rounds/start` | ADMIN | — | Round bootstrap. |
| `GET /api/admin/metrics/rate-limits` | ADMIN | `admin.metrics.rate_limits.read` | Rate-limit/abuse summary. |
| `POST /api/admin/metrics/rate-limits/clear` | ADMIN | `admin.metrics.rate_limits.clear` | Mutating retention action. |
| `GET /api/admin/metrics/metrics` | ADMIN or `METRICS_SCRAPE_TOKEN` | `admin.metrics.prometheus.read` | Duplicate scrape surface; always authenticated. |
| `GET /api/admin/metrics/payout-reconciliation` | ADMIN | `admin.metrics.payout_reconciliation.read` | Payout ledger summary. |
| `GET /api/admin/metrics/rate-limit-summary` | ADMIN | `admin.metrics.rate_limit_summary.read` | Counter snapshot. |
| `GET /api/admin/cors-diagnostics` | ADMIN | `admin.cors_diagnostics.read` | Resolved CORS allowlist. |
| `GET /api/admin/dead-letter` | ADMIN | `admin.dead_letter.list` | DLQ inspection. |
| `POST /api/admin/dead-letter/retry-all` | ADMIN | `admin.dead_letter.retry_all` | Supports `dryRun`. |
| `POST /api/admin/dead-letter/:id/retry` | ADMIN | `admin.dead_letter.retry` | Supports `dryRun`. |
| `GET /api/admin/bet-audit` | ADMIN | `admin.bet_audit.read` | Bet audit events (tx hashes redacted). |
| `GET /api/admin/runtime-flags` | ADMIN | `admin.runtime_flags.read` | Non-secret runtime config. |

## Audit trail

`auditAdminAction(action)` runs after `requireAdmin` and writes one
`admin.action` event when the response finishes. Events are emitted to Winston
and, when `AUDIT_LOG_DATABASE_ENABLED` is not `false`, persisted to the
`AuditLog` table with:

- actor wallet/user id and IP (no request bodies or secrets),
- endpoint, method, request id and HTTP status,
- `resourceType: "admin"` and the action name as `resourceId`.

Forbidden attempts never reach the middleware, so they are not persisted; the
authorization decision itself is still covered by `403` responses and the
route-auth registry tests (`src/tests/admin-rbac.spec.ts`).

## Hackathon mode

`resolveFeatures("hackathon")` sets `adminRoutes: false`, so `/api/admin/*` is
not mounted at all. The only exception is `ENABLE_CORS_DIAGNOSTICS=true`, which
mounts `/api/admin/cors-diagnostics` on its own — that router keeps its own
`requireAdmin`, so it cannot be read anonymously.
