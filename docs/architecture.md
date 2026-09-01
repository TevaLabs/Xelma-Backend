# Architecture

This document gives new contributors a quick map of the system: how requests
flow, where data lives, and where the Soroban blockchain boundary sits.

For the runtime-mode flag matrix (`DATA_MODE`, `BET_STUB_MODE`, etc.) see
[runtime-modes.md](runtime-modes.md).

---

## Entrypoints

The repo ships **two Express applications** built from a single factory.
`src/app-factory.ts` owns all HTTP wiring — middleware, route mounting, CORS,
error handlers — and exposes a `createApp({ mode })` function. The
entrypoints only choose a mode.

| npm command | Entry file | Mode | Use when |
|---|---|---|---|
| `npm run dev` | `src/index.ts` | `full` | Default. Full backend — real DB, WebSocket, Soroban, schedulers. |
| `npm run dev:hackathon` | `src/server.ts` → `src/app.ts` | `hackathon` | Mock/demo app, no database required. |
| `npm start` / `npm run start:full` | `dist/index.js` | `full` | Production Render start (compiled). |
| `npm run start:hackathon` | `dist/server.js` | `hackathon` | Production Render hackathon profile (compiled). |

Both entrypoints create an HTTP server, initialize Socket.IO, and listen on
`PORT` (default 3000 for full, 3001 for hackathon). The full entrypoint also
starts the price oracle, round scheduler, and oracle settlement service.

The feature-flag surface that differs between modes is defined in
`AppFeatures` inside [`src/app-factory.ts`](../src/app-factory.ts) and
documented in the [CONTRIBUTING.md](../CONTRIBUTING.md) "Feature flags" table.

---

## Request flow

```
                          ┌──────────────────────────────┐
                          │        Express router         │
                          └──────────┬───────────────────┘
                                     │
                          ┌──────────▼───────────────────┐
                          │     Middleware stack           │
                          │  (auth, rate-limit, CORS,     │
                          │   helmet, request-id, logs)   │
                          └──────────┬───────────────────┘
                                     │
                    ┌────────────────▼────────────────────────┐
                    │            src/routes/                   │
                    │  Thin handlers that validate the        │
                    │  request and delegate to a service.     │
                    └──┬─────────┬────────────┬──────────────┘
                       │         │            │
            ┌──────────▼───┐ ┌──▼──────────┐ ┌▼───────────────┐
            │   Services    │ │   Prisma    │ │   Soroban      │
            │  (business    │ │   ORM       │ │   (blockchain)  │
            │   logic)      │ │             │ │                 │
            └──────┬────────┘ └──────┬──────┘ └───────┬────────┘
                   │                 │                 │
            ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼────────┐
            │ PostgreSQL   │  │ Stellar RPC │  │ CoinGecko     │
            │ (primary)    │  │ (on-chain)  │  │ (price feed)  │
            └─────────────┘  └─────────────┘  └───────────────┘
```

### Layers

| Layer | Directory | Responsibility |
|---|---|---|
| **Routes** | `src/routes/` | Parse request, run Zod validation, call a service, return JSON. No business logic. |
| **Services** | `src/services/` | All business rules, pricing math, payout calculation, lifecycle management. |
| **ORM** | `src/lib/prisma.ts` | Singleton Prisma client. All DB access goes through Prisma. |
| **Soroban** | `src/services/soroban.service.ts` | Smart-contract calls via vendored `@tevalabs/xelma-bindings`. |
| **Middleware** | `src/middleware/` | Auth (JWT), rate limiting, security headers, metrics, request-id. |

---

## Data stores

| Store | Purpose | Access |
|---|---|---|
| **PostgreSQL** | Users, rounds, predictions, bets, leaderboard, notifications, chat, audit logs, outbox events, idempotency keys. | Prisma ORM (`src/lib/prisma.ts`) |
| **Redis** | Socket.IO multi-instance adapter, distributed idempotency locks, scheduler leader election. | `redis` npm package; configured via `REDIS_URL` |
| **Soroban (Stellar)** | On-chain round creation, bet placement, and payout settlement. | `@tevalabs/xelma-bindings` vendored at `vendor/xelma-bindings` |
| **CoinGecko API** | Real-time XLM/USD price feed (polled every 10 s). | `src/services/oracle.ts` via axios |

---

## Soroban boundary

The Soroban smart contract is the **settlement layer**. The backend calls it
for three operations:

1. **Round creation** — `sorobanService.createRound()` records the round on-chain.
2. **Bet placement** — `sorobanService.placeBet()` / `placePrecisionBet()` submits a transaction to the contract.
3. **Round resolution** — `sorobanService.resolveRound()` finalises the outcome and triggers payout distribution.

### Controlling flags

| Flag | Effect |
|---|---|
| `BET_STUB_MODE=true` (default) | Bets are recorded in PostgreSQL only; no on-chain calls. Use for local dev and demos. |
| `BET_STUB_MODE=false` | Bets are submitted to the Soroban contract. |
| `SOROBAN_FAIL_CLOSED=true` | Money paths (bet, resolve) abort if chain verification fails. Recommended for production. |
| `SOROBAN_FAIL_CLOSED=false` (default) | Chain failures are logged and settlement proceeds with DB-only data. |
| `SOROBAN_CONTRACT_ID` unset | Soroban service disables entirely; health endpoint shows `unavailable`. |

### Vendored bindings

The contract client is vendored at `vendor/xelma-bindings` and pinned by
[`bindings.pin.json`](../bindings.pin.json). The startup validator
(`src/utils/bindings-validator.ts`) checks that the vendored commit matches
the pin. See [bindings-upgrade.md](bindings-upgrade.md) before changing
anything under `vendor/`.

### Money-path safety

All balance/amount fields use `Decimal(20,8)` in Prisma. Financial math must
use the utilities in `src/utils/decimal.util.ts` — never native JS floats.

---

## Adding a route

1. Add it to `mountApiRoutes()` in `src/app-factory.ts`. It is served by both apps and mirrored under `/api/v1` automatically.
2. If it should exist in only one app, gate it behind a feature flag — add a new one to `AppFeatures` if none fits.
3. Add a matching entry to `PARITY_ALLOWLIST` in `src/security/route-parity.registry.ts`.

`src/tests/route-parity.spec.ts` fails CI if a route appears in one app
without an allowlist entry or if an entry goes stale.

---

## See also

- [CONTRIBUTING.md](../CONTRIBUTING.md) — development workflow, feature flags, PR checklist.
- [runtime-modes.md](runtime-modes.md) — `DATA_MODE`, `BET_STUB_MODE`, `ROUNDS_MOCK_MODE` flag matrix.
- [bindings-upgrade.md](bindings-upgrade.md) — how to update vendored Soroban bindings.
- [README.md](../README.md) — full project documentation, endpoint list, environment setup.
