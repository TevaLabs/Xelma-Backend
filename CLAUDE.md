# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev              # Start dev server with ts-node-dev (auto-reload)
npm run build            # Compile TypeScript to dist/
npm start                # Start production server (node dist/index.js)

# Type checking & linting
npm run lint             # tsc --noEmit (type-check only, no output)

# Testing
npm test                 # Run all tests
npm run test:unit        # Run unit tests only
npm run test:unit:coverage # Unit tests with coverage report
npm run test:integration # Run integration tests only
npm run test:watch       # Run tests in watch mode

# Run a single test file
npx jest src/tests/auth-race.spec.ts
npx jest --testPathPattern="education-tip"

# Database
npm run prisma:generate  # Regenerate Prisma client after schema changes
npm run prisma:migrate   # Run pending migrations

# Vendored Soroban bindings (see docs/bindings-upgrade.md)
npm run check:bindings       # Pinned commit + build artifacts (fast, no install)
npm run check:bindings:abi   # Full contract surface + ABI check (needs npm run build)

# CI (runs lint → build → test)
npm run ci
```

## Architecture

**Layer structure:** Routes → Services → Prisma ORM → PostgreSQL

- [src/index.ts](src/index.ts) — Express app factory and server startup
- [src/socket.ts](src/socket.ts) — Socket.IO initialization
- [src/routes/](src/routes/) — Express route handlers (auth, rounds, predictions, leaderboard, chat, notifications, education, price, user)
- [src/services/](src/services/) — All business logic; routes are thin wrappers over services
- [src/middleware/](src/middleware/) — Auth (JWT), rate limiting, Zod-based request validation
- [src/lib/](src/lib/) — Prisma singleton client
- [src/schemas/](src/schemas/) — Zod validation schemas (shared between middleware and services)
- [src/utils/](src/utils/) — JWT helpers, challenge generation, decimal math, Winston logger
- [prisma/schema.prisma](prisma/schema.prisma) — Single source of truth for the database schema

**Core domain concepts:**
- **Rounds** — Prediction market rounds with `UP_DOWN` or `LEGENDS` game modes; managed by cron scheduler in [src/services/round-scheduler.service.ts](src/services/round-scheduler.service.ts)
- **Predictions** — User predictions on round outcomes; placement is transactional and race-safe
- **Resolution** — Rounds are auto-resolved by comparing entry/exit XLM price via CoinGecko oracle ([src/services/oracle.ts](src/services/oracle.ts))
- **Auth** — Wallet signature challenge/connect flow using Stellar keypairs; challenges are atomically consumed (one-time use)
- **Soroban** — Smart contract interactions via `@tevalabs/xelma-bindings` and `@stellar/stellar-sdk`; controlled by `SOROBAN_ADMIN_SECRET` / `SOROBAN_ORACLE_SECRET`. The bindings are vendored at `vendor/xelma-bindings` and pinned by [bindings.pin.json](bindings.pin.json), which also declares the contract methods/types [src/services/soroban.service.ts](src/services/soroban.service.ts) depends on. [src/utils/bindings-validator.ts](src/utils/bindings-validator.ts) enforces that pin in CI and at startup — see [docs/bindings-upgrade.md](docs/bindings-upgrade.md) before changing anything under `vendor/`
- **WebSocket** — Real-time events (round open/close/resolve, price ticks, notifications) broadcast via Socket.IO in [src/services/websocket.service.ts](src/services/websocket.service.ts)

**Monetary precision:** All balance/amount fields use `Decimal(20, 8)` in Prisma. Never use native JS floats for financial math — use the utilities in [src/utils/decimal.util.ts](src/utils/decimal.util.ts).

## Testing

Tests live in `src/tests/*.spec.ts`. Tests are split into **unit** and **integration** projects in [jest.config.ts](jest.config.ts):
- **Unit tests** (`npm run test:unit`) — fast, no external dependencies
- **Integration tests** (`npm run test:integration`) — require PostgreSQL

The `integrationTestFiles` array in `jest.config.ts` defines which tests run as integration. Both projects run under `npm test`.

Tests require a running PostgreSQL database. The test environment is configured in [.env.test](.env.test) and loaded by [jest.setup.js](jest.setup.js). The CI pipeline uses a PostgreSQL 16 service container.

## Key Environment Variables

See [.env.example](.env.example) for the full list. Critical variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Required for server startup |
| `SOROBAN_CONTRACT_ID` | Deployed prediction market contract |
| `SOROBAN_ADMIN_SECRET` | Admin keypair for contract operations |
| `SOROBAN_ORACLE_SECRET` | Oracle keypair for price settlement |
| `ROUND_SCHEDULER_ENABLED` | Set to `true` to activate cron-based round creation |
| `ROUND_SCHEDULER_MODE` | `UP_DOWN` or `LEGENDS` |
| `BINDINGS_CHECK` | `off`/`warn`/`strict` — startup enforcement for vendored-bindings skew |

## API Documentation

After building, generate and serve OpenAPI docs:
```bash
npm run docs:openapi     # Outputs to dist/openapi.json
npm run dev              # Swagger UI available at /api-docs
```
