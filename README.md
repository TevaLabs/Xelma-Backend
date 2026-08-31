# Xelma Backend

TypeScript/Node.js backend for the [Xelma](https://github.com/TevaLabs/Xelma-Blockchain) decentralized XLM price prediction market, built on the Stellar blockchain (Soroban).

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Project Structure](#project-structure)
- [Architecture](#architecture)
  - [Entrypoints](#entrypoints)
  - [Core Services](#core-services)
  - [Routes & Endpoints](#routes--endpoints)
  - [Middleware](#middleware)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Environment Setup](#environment-setup)
- [Running the Server](#running-the-server)
- [API Documentation](#api-documentation)
- [Testing](#testing)
- [Operations & Alerting](#operations--alerting)
- [Migration Safety](#migration-safety)
- [Scripts](#scripts)
- [Troubleshooting](#troubleshooting)

---

## Overview

**Xelma Backend** is the server-side component of a blockchain-based prediction market platform where users predict XLM (Stellar Lumens) price movements. The backend orchestrates:

- **Real-time price data** from CoinGecko
- **Blockchain integration** with Soroban smart contracts on Stellar
- **WebSocket updates** for live round status and price changes
- **JWT-based authentication** with wallet signature verification
- **PostgreSQL database** for user profiles, rounds, predictions, and stats
- **Role-based access control** (User, Admin, Oracle) for secure operations
- **Automated scheduling** for round creation, locking, and resolution

The platform supports two game modes:

1. **UP_DOWN** - Binary predictions (price goes up or down)
2. **LEGENDS** - Range-based predictions (price lands in specific ranges)

---

## Key Features

- âœ… **Wallet-Based Authentication**: Users authenticate with Stellar wallet signatures (no passwords)
- âœ… **Two Game Modes**: UP_DOWN (binary) and LEGENDS (range-based) prediction markets
- âœ… **Real-Time Price Oracle**: Polls CoinGecko every 10 seconds for XLM/USD prices
- âœ… **Soroban Integration**: Creates and resolves rounds on-chain via `@tevalabs/xelma-bindings`
- âœ… **WebSocket Support**: Live updates for prices, rounds, chat, and notifications
- âœ… **Leaderboard System**: Tracks wins, earnings, and streaks across game modes
- âœ… **Automated Schedulers**: Cron jobs for round creation, locking, and resolution
- âœ… **Transactional Outbox**: Notification and WebSocket side-effects are written atomically with DB commits â€” guaranteed at-least-once delivery even across process crashes
- âœ… **Dead-Letter Queue**: Failed dispatches are persisted and replayable via admin endpoints
- âœ… **OpenAPI Documentation**: Auto-generated Swagger UI at `/api-docs`
- âœ… **Rate Limiting**: Protects endpoints from abuse
- âœ… **Comprehensive Logging**: Winston-based logging for debugging and monitoring

---

## Project Structure

```
Xelma-Backend/
â”œâ”€â”€ src/
â”‚   â”œâ”€â”€ index.ts                    # Application entry point
â”‚   â”œâ”€â”€ socket.ts                   # Socket.IO initialization with JWT auth
â”‚   â”‚
â”‚   â”œâ”€â”€ routes/                     # Express route handlers
â”‚   â”‚   â”œâ”€â”€ auth.routes.ts          # Authentication (login, verify)
â”‚   â”‚   â”œâ”€â”€ user.routes.ts          # User profile management
â”‚   â”‚   â”œâ”€â”€ rounds.routes.ts        # Round creation & resolution (admin/oracle)
â”‚   â”‚   â”œâ”€â”€ predictions.routes.ts   # Submit & claim predictions
â”‚   â”‚   â”œâ”€â”€ leaderboard.routes.ts   # Leaderboard & user stats
â”‚   â”‚   â”œâ”€â”€ education.routes.ts     # Educational tips
â”‚   â”‚   â”œâ”€â”€ chat.routes.ts          # Chat message submission
â”‚   â”‚   â””â”€â”€ notifications.routes.ts # User notifications
â”‚   â”‚
â”‚   â”œâ”€â”€ services/                   # Business logic layer
â”‚   â”‚   â”œâ”€â”€ oracle.ts               # Price fetching from CoinGecko
â”‚   â”‚   â”œâ”€â”€ soroban.service.ts      # Soroban contract interaction
â”‚   â”‚   â”œâ”€â”€ round.service.ts        # Round lifecycle management
â”‚   â”‚   â”œâ”€â”€ prediction.service.ts   # Prediction submission & validation
â”‚   â”‚   â”œâ”€â”€ resolution.service.ts   # Round resolution & payout calculation
â”‚   â”‚   â”œâ”€â”€ leaderboard.service.ts  # Leaderboard data aggregation
â”‚   â”‚   â”œâ”€â”€ websocket.service.ts    # WebSocket event emissions
â”‚   â”‚   â”œâ”€â”€ notification.service.ts # Notification creation & delivery
â”‚   â”‚   â”œâ”€â”€ education-tip.service.ts# Educational content management
â”‚   â”‚   â”œâ”€â”€ chat.service.ts         # Chat message handling
â”‚   â”‚   â”œâ”€â”€ scheduler.service.ts    # General cron job scheduler
â”‚   â”‚   â””â”€â”€ round-scheduler.service.ts # Round creation/locking scheduler
â”‚   â”‚
â”‚   â”œâ”€â”€ middleware/                 # Express middleware
â”‚   â”‚   â”œâ”€â”€ auth.middleware.ts      # JWT verification & role checking
â”‚   â”‚   â””â”€â”€ rateLimiter.middleware.ts # Rate limiting configuration
â”‚   â”‚
â”‚   â”œâ”€â”€ utils/                      # Utility functions
â”‚   â”‚   â”œâ”€â”€ logger.ts               # Winston logger setup
â”‚   â”‚   â”œâ”€â”€ jwt.util.ts             # JWT generation & verification
â”‚   â”‚   â””â”€â”€ challenge.util.ts       # Wallet challenge generation
â”‚   â”‚
â”‚   â”œâ”€â”€ types/                      # TypeScript type definitions
â”‚   â”‚   â”œâ”€â”€ auth.types.ts           # Authentication types
â”‚   â”‚   â”œâ”€â”€ round.types.ts          # Round & game mode types
â”‚   â”‚   â”œâ”€â”€ leaderboard.types.ts    # Leaderboard types
â”‚   â”‚   â”œâ”€â”€ education.types.ts      # Education tip types
â”‚   â”‚   â”œâ”€â”€ chat.types.ts           # Chat message types
â”‚   â”‚   â”œâ”€â”€ prisma.types.ts         # Prisma client extensions
â”‚   â”‚   â””â”€â”€ xelma-bindings.d.ts     # Xelma bindings type stubs
â”‚   â”‚
â”‚   â”œâ”€â”€ lib/
â”‚   â”‚   â””â”€â”€ prisma.ts               # Prisma client instance
â”‚   â”‚
â”‚   â”œâ”€â”€ docs/
â”‚   â”‚   â””â”€â”€ openapi.ts              # OpenAPI/Swagger configuration
â”‚   â”‚
â”‚   â”œâ”€â”€ scripts/
â”‚   â”‚   â”œâ”€â”€ generate-openapi.ts     # Generate OpenAPI JSON
â”‚   â”‚   â””â”€â”€ export-postman.ts       # Export Postman collection
â”‚   â”‚
â”‚   â””â”€â”€ tests/                      # Jest test suites
â”‚       â”œâ”€â”€ education-tip.service.spec.ts
â”‚       â”œâ”€â”€ education-tip.route.spec.ts
â”‚       â””â”€â”€ round.spec.ts
â”‚
â”œâ”€â”€ prisma/
â”‚   â”œâ”€â”€ schema.prisma               # Prisma database schema
â”‚   â”œâ”€â”€ migrations/                 # Database migrations
â”‚   â””â”€â”€ seed.ts                     # Database seeding script
â”‚
â”œâ”€â”€ dist/                           # Compiled JavaScript output
â”œâ”€â”€ docs/                           # Additional documentation
â”œâ”€â”€ .env.example                    # Environment variables template
â”œâ”€â”€ package.json                    # Project dependencies & scripts
â”œâ”€â”€ tsconfig.json                   # TypeScript configuration
â”œâ”€â”€ jest.config.ts                  # Jest testing configuration
â””â”€â”€ README.md                       # This file
```

---

## Architecture

### Data Sources

The hackathon app and the production app share the same services, but the data backend can be switched per-endpoint via environment flags.

| Endpoint                        | `DATA_MODE=live` (default)                    | `DATA_MODE=mock`                                                                                            |
| ------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /api/prices`               | CoinGecko API (30 s cache)                    | Static in-memory array (`mockData.prices` in [src/data/mockData.ts](src/data/mockData.ts))                  |
| `GET /api/price`                | Production XLM oracle providers               | Same oracle path (production app only; not mounted on hackathon)                                            |
| `GET /api/rounds`               | Prisma / Postgres (`hackathon_rounds` table)  | Same â€” Prisma is always used for rounds                                                                   |
| `GET /api/leaderboard`          | Prisma / Postgres leaderboard table           | In-memory seed (`mockLeaderboard` in [src/data/mockData.ts](src/data/mockData.ts)) when `DATA_STORE=memory` |
| `GET /api/stats`                | Prisma / Postgres aggregation                 | `MOCK_PLATFORM_STATS` constants (zero-value defaults)                                                       |
| `GET /api/health` â†’ `soroban` | Live `soroban.isReady()` flag                 | Same â€” no extra network call; reflects initialization state only                                          |

**Controlling flags** (set in `.env` or as environment variables):

| Variable              | Values                         | Effect                                                              |
| --------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `DATA_MODE`           | `live` (default), `mock`       | Switches price source and stats fallback                            |
| `DATA_STORE`          | `postgres` (default), `memory` | Switches repository adapter for rounds, leaderboard, bets           |
| `SOROBAN_CONTRACT_ID` | contract address or unset      | When unset, Soroban service disables and health shows `unavailable` |

See [src/data/mockData.ts](src/data/mockData.ts) for the full in-memory seed data and fallback constants.

> **Runtime modes reference:** For the complete flag matrix (DATA_MODE, BET_STUB_MODE, ROUNDS_MOCK_MODE), recommended combinations, and interaction diagrams, see **[docs/runtime-modes.md](docs/runtime-modes.md)**.

---

### Entrypoints

The repo has two Express applications. **New contributors should always use `npm run dev`.**

| Script                             | File                                        | Use when                                                         |
| ---------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| `npm run dev`                      | `src/index.ts`                              | Everyday development — full backend, real DB, WebSocket, Soroban |
| `npm run dev:hackathon`            | `src/server.ts`                             | Demo without a database — mock data only                         |
| `npm start` / `npm run start:full` | `dist/index.js` (compiled `src/index.ts`)   | **Production Render start command** — full backend (compiled)    |
| `npm run start:hackathon`          | `dist/server.js` (compiled `src/server.ts`) | Hackathon Render start command — demo server (compiled)          |

See [docs/architecture.md](docs/architecture.md) for the full architecture decision, file map, migration plan, and a checklist for adding new routes.

---

### Core Services

#### **1. Price Oracle (`oracle.ts`)**

- **Purpose**: Fetches real-time XLM/USD price from CoinGecko
- **Polling Interval**: Every 10 seconds
- **Singleton Pattern**: Single instance across the application
- **Used By**: Round service, WebSocket service for price updates

#### **2. Soroban Service (`soroban.service.ts`)**

- **Purpose**: Interfaces with Soroban smart contracts on Stellar blockchain
- **Capabilities**:
  - Create new rounds on-chain
  - Lock rounds for betting
  - Resolve rounds with final prices
  - Mint initial tokens for users
  - Place bets and claim winnings
- **Configuration**: Requires `SOROBAN_CONTRACT_ID`, admin & oracle keypairs
- **Failsafe**: Gracefully disables if configuration is missing

#### **3. Round Service (`round.service.ts`)**

- **Purpose**: Manages the complete lifecycle of prediction rounds
- **Responsibilities**:
  - Start new rounds (UP_DOWN or LEGENDS mode)
  - Lock rounds when betting period ends
  - Fetch active, locked, and upcoming rounds
  - Calculate pool sizes (UP vs DOWN pools)
- **Integrations**: Soroban service, WebSocket service, notification service

#### **4. Prediction Service (`prediction.service.ts`)**

- **Purpose**: Handles user bet submissions
- **Validations**:
  - Round is active and not locked
  - User has sufficient balance
  - No duplicate predictions per round
  - Correct prediction format (side for UP_DOWN, range for LEGENDS)
- **Actions**:
  - Deducts user balance
  - Calls Soroban contract to place bet
  - Updates round pool sizes
  - Emits WebSocket events

#### **5. Resolution Service (`resolution.service.ts`)**

- **Purpose**: Resolves completed rounds and distributes winnings
- **Process**:
  1. Fetch final price from oracle
  2. Update round status to RESOLVED
  3. Calculate payouts for winning predictions
  4. Update user stats (wins, earnings, streaks)
  5. Call Soroban contract to finalize round
  6. Send win/loss notifications
- **Payout Formula**: Proportional to bet size and total pool ratio

#### **6. Leaderboard Service (`leaderboard.service.ts`)**

- **Purpose**: Aggregates and ranks user performance data
- **Metrics**:
  - Total earnings
  - Win/loss counts per game mode
  - Current win streak
  - Accuracy percentage
- **Queries**: Optimized database queries with pagination support
- **Materialized sorted set**: When Redis is available, a Redis sorted set
  (`ZSET`) stores every user's `totalEarnings` as the score. Rank lookups
  become O(log N) instead of a full-table `COUNT(*)`. The set is kept in sync
  after every `updateUserStatsForRound` call and invalidated whenever the
  leaderboard namespace is flushed. The DB path is always the fallback when
  Redis is unavailable.

#### **7. WebSocket Service (`websocket.service.ts`)**

- **Purpose**: Broadcasts real-time events to connected clients
- **Events**:
  - `price_update` - New XLM price every 5 seconds
  - `round_update` - Round status changes (created, locked, resolved)
  - `user_balance_update` - User balance changes
  - `new_notification` - New notifications
  - `new_message` - New chat messages
- **Authentication**: JWT-based socket authentication

#### **8. Scheduler Services**

- **`scheduler.service.ts`**: General-purpose cron job runner
- **`round-scheduler.service.ts`**: Automated round management
  - Creates new rounds every 4 minutes (configurable)
  - Locks rounds after 30 seconds (configurable)
  - Controlled by `ROUND_SCHEDULER_ENABLED` environment variable

> **API-only mode**: Set `API_ONLY=true` to start the HTTP server with
> all schedulers, oracle polling, and the WebSocket price ticker
> disabled. This is the recommended setup for split deployments â€” one
> dedicated worker process runs background jobs while one or more
> stateless processes serve HTTP â€” and for safer local debugging.

> **Bet mode (`BET_STUB_MODE`)**: Controls whether `/api/bets` endpoints
> submit transactions on-chain or just record intent locally.
>
> | `BET_STUB_MODE`  | `sorobanService.placeBet` | `sorobanService.placePrecisionBet` | Use case                                                                        |
> | ---------------- | ------------------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
> | `true` (default) | Skipped                   | Skipped                            | Local dev, demos, hackathon â€” no Soroban keypairs or deployed contract needed |
> | `false`          | Called                    | Called                             | Production â€” bets are submitted to the Soroban smart contract                 |
>
> The active mode is logged at startup: `Bet mode: STUB (no on-chain calls)` or `Bet mode: ON-CHAIN (Soroban)`.

#### **8a. Outbox Service (`outbox.service.ts`)** â€” Issue #18

- **Purpose**: Guarantees at-least-once delivery of notification and WebSocket side-effects
- **How it works**:
  1. Business transactions (payout, prediction) write `OutboxEvent` rows _inside_ the same `prisma.$transaction()` call â€” atomically with the state change.
  2. A background poller (cron, every `OUTBOX_POLL_INTERVAL_SECONDS`) reads `PENDING` rows and dispatches them.
  3. On success the row is marked `PROCESSED`. On failure `attempts` is incremented; once `OUTBOX_MAX_ATTEMPTS` is reached the row is marked `FAILED` and escalated to the existing DLQ.
- **Why this matters**: Before this change, notifications fired _after_ the transaction committed. A process crash between commit and notification call silently dropped the event. Now the event is durable from the moment the transaction commits.
- **Env vars**: `OUTBOX_POLL_INTERVAL_SECONDS`, `OUTBOX_BATCH_SIZE`, `OUTBOX_MAX_ATTEMPTS`, `OUTBOX_RETENTION_DAYS`

#### **9. Notification Service (`notification.service.ts`)**

- **Purpose**: Creates and delivers notifications to users
- **Types**: WIN, LOSS, ROUND_START, BONUS_AVAILABLE, ANNOUNCEMENT
- **Channels**: Database storage + WebSocket emission
- **Filtering**: Respects user notification preferences

#### **10. Chat Service (`chat.service.ts`)**

- **Purpose**: Handles global chat message submission and retrieval
- **Features**:
  - Message validation (max 500 characters)
  - Automatic user info attachment
  - WebSocket broadcasting
  - Pagination support

#### **11. Education Tip Service (`education-tip.service.ts`)**

- **Purpose**: Provides educational content for users
- **Features**:
  - Daily tip delivery
  - Random tip selection
  - Category-based filtering

---

### Routes & Endpoints

#### **Authentication (`/api/auth`)**

- `POST /challenge` - Request a wallet authentication challenge (returns challenge string)
- `POST /connect` - Verify signed challenge and issue JWT token

#### **User Management (`/api/user`)**

- `GET /profile` - [Auth] Get authenticated user's profile
- `GET /balance` - [Auth] Get current virtual balance
- `GET /stats` - [Auth] Get detailed user statistics
- `PATCH /profile` - [Auth] Update user preferences (nickname, avatar, preferences)
- `GET /transactions` - [Auth] Get paginated transaction history
- `GET /:address/stats` - Get on-chain user stats from Soroban
- `GET /:address/history` - Get paginated bet history for a wallet address
- `GET /:walletAddress/public-profile` - Get any user's public profile

#### **Round Management (`/api/rounds`)**

- `POST /start` - [Admin] Start a new round
- `GET /active` - Get all active rounds
- `GET /:id` - Get specific round details
- `POST /:id/resolve` - [Oracle] Resolve a round with final price

##### Frontend round card contract

The rounds endpoint now returns a unified array of frontend cards that preserves the existing hackathon card layout while allowing a live Soroban round to be surfaced alongside mock assets.

- When Soroban data is available, the mapper emits one card with `source: "live"` for the live XLM round and fills the remaining slots with mock cards for BTC and ETH using `source: "mock"`.
- When no live chain round exists, the endpoint returns only mock cards so the frontend continues rendering the same multi-asset layout without changes.

Example response:

```json
{
  "success": true,
  "data": {
    "source": "soroban",
    "rounds": [
      {
        "id": "soroban-99",
        "asset": "XLM",
        "mode": "updown",
        "status": "live",
        "startPrice": 120,
        "poolUp": 2,
        "poolDown": 1,
        "totalPool": 3,
        "predictionCount": 1,
        "closesAt": "2026-07-25T00:00:00.000Z",
        "source": "live",
        "roundStatus": "ACTIVE",
        "roundTiming": { "startsAt": "...", "endsAt": "..." },
        "priceData": { "startPrice": 120, "currentPrice": 121.2 },
        "poolValues": { "upPool": 2, "downPool": 1, "totalPool": 3 },
        "predictionMetadata": { "predictionCount": 1, "canPredict": true }
      },
      {
        "id": "btc-round-1",
        "asset": "BTC",
        "source": "mock"
      }
    ]
  }
}
```

##### Mapper responsibilities

The mapper in [src/utils/soroban-round.mapper.ts](src/utils/soroban-round.mapper.ts) is the single place that converts live Soroban data into the frontend contract. It keeps the mapping concern isolated from the route layer and provides:

- live-to-frontend mapping for the active Soroban round
- mock fallback cards for unsupported assets so the multi-card UI remains intact
- source metadata (`"live"` vs `"mock"`) on every returned card
- the same core round fields the frontend already expects (`id`, `asset`, `mode`, `status`, `startPrice`, `pool*`, `closesAt`)

#### **Predictions (`/api/predictions`)**

- `POST /submit` - [Auth] Submit a prediction for a round
- `GET /user/:userId` - Get user's prediction history
- `GET /round/:roundId` - Get all predictions for a round

#### **Bets (`/api/bets`)**

- `POST /up-down` - [Auth] Submit an UP/DOWN bet (stub or on-chain)
- `POST /precision` - [Auth] Submit a precision bet (stub or on-chain)

#### **Tournaments (`/api/tournaments`)**

- `GET /` - List tournaments. Query: `?mode=UP_DOWN|LEGENDS`, `?status=UPCOMING|ACTIVE|COMPLETED|CANCELLED`, `limit`, `offset` (mode and status may be combined). Response: `{ success, data, pagination: { limit, offset, total } }`
- `GET /:id` - Get tournament detail by id
- `POST /:id/join` - [Auth] Join a tournament

#### **Leaderboard (`/api/leaderboard`)**

- `GET /` - Get global leaderboard (paginated, optional auth for user position)

#### **Education (`/api/education`)**

- `GET /guides` - Get all educational guides grouped by category
- `GET /tip?roundId=<uuid>` - Generate contextual educational tip for a resolved round

#### **Chat (`/api/chat`)**

- `POST /send` - [Auth] Send a chat message
- `GET /history` - Get recent chat messages (paginated, max 50)

#### **Notifications (`/api/notifications`)**

- `GET /` - [Auth] Get paginated notifications
- `GET /unread-count` - [Auth] Get unread notification count
- `GET /:id` - [Auth] Get a specific notification
- `PATCH /:id/read` - [Auth] Mark a notification as read
- `PATCH /read-all` - [Auth] Mark all notifications as read
- `DELETE /:id` - [Auth] Delete a notification
- `DELETE /` - [Auth] Delete all read notifications

#### **System Endpoints**

- `GET /` - Health check with timestamp
- `GET /health` - Detailed health check (uptime, status)
- `GET /metrics` - Prometheus metrics for HTTP, schedulers, oracle, predictions, WebSocket, rate limits, and DB pool settings
- `GET /api/price` - **Production only.** Current XLM/USD oracle price as a decimal string (`price_usd`) with staleness / provider info. **Not** an alias of `/api/prices`.
- `GET /api/prices` - Multi-asset BTC / ETH / XLM ticker (CoinGecko, 30 s cache). Production returns the raw object; the hackathon app wraps it in `{ success, data }`. **Not** an alias of `/api/price`.
- `GET /api-docs` - Swagger UI documentation
- `GET /api-docs.json` - OpenAPI specification

> **Price endpoints — pick the right path**
>
> | Path              | App                                                                   | Payload shape                                                                    | Use when                            |
> | ----------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------- |
> | `GET /api/price`  | Production (`npm run dev` / `src/index.ts`)                           | `{ asset: "XLM", price_usd, stale, provider, lastUpdatedAt, source, timestamp }` | You need the XLM oracle feed        |
> | `GET /api/prices` | Production **and** hackathon (`npm run dev:hackathon` / `src/app.ts`) | `{ BTC, ETH, XLM, stale, lastUpdatedAt }` (hackathon: under `{ success, data }`) | You need a multi-asset price widget |
>
> Keeping both is intentional: they are different contracts, not duplicates. Do not call `/api/price` against the hackathon app (it is not mounted there). Unversioned production `/api/*` routes also send `Deprecation` / `Sunset` headers toward a future `/api/v1` successor; that does **not** mean `/api/price` is deprecated in favor of `/api/prices`.

---

### Middleware

#### **Authentication Middleware (`auth.middleware.ts`)**

- **`authenticateUser`**: Verifies JWT token and attaches user to request
- **`requireAdmin`**: Ensures user has ADMIN role
- **`requireOracle`**: Ensures user has ORACLE role

#### **Rate Limiter Middleware (`rateLimiter.middleware.ts`)**

- Prevents API abuse with per-IP and per-user limits
- Single prediction submit: 10 requests/minute per user
- Batch prediction submit: **3 requests/minute per user** (stricter; each batch may include up to 50 predictions)
- Batch leaderboard lookup: 10 requests/minute per user
- Authenticated bets (`POST /api/bets/up-down`, `POST /api/bets/precision`): **5 requests/minute per IP**
- Auth, chat, admin round creation, and oracle resolve endpoints have tailored policies
- Rate-limit hits are recorded for the admin metrics dashboard (`GET /api/admin/metrics/rate-limits`)

#### **Route Authorization Registry (`src/security/route-auth.registry.ts`)**

- Canonical list of API routes and required auth levels (`public`, `authenticated`, `admin`, `oracle`)
- `src/tests/security.spec.ts` and `src/tests/route-auth.registry.spec.ts` fail CI when the registry drifts from implemented routes
- Role middleware (`requireAdmin`, `requireOracle`, `authenticateUser`) is built on a shared `requireRole` helper in `auth.middleware.ts`

---

### Database Schema

The application uses **PostgreSQL** via **Prisma ORM**. Key models:

- **User**: Wallet address, virtual balance, wins, streaks, roles
- **Round**: Game mode, status, prices, pools, timestamps
- **Prediction**: User bets with side/range, amounts, payouts
- **Notification**: User notifications with types and read status
- **Message**: Global chat messages
- **UserStats**: Aggregated performance metrics per game mode
- **Transaction**: Balance change history (bonus, win, loss, etc.)
- **AuthChallenge**: Wallet signature challenges for authentication
- **AuditLog**: Security audit trail for authentication and authorization events

---

### Data Retention & Audit Logging

The backend implements automated data retention policies to control storage growth while maintaining security audit trails.

#### Audit Logging

All authentication and authorization events are logged for security monitoring and compliance:

- **Events Logged**: Challenge lifecycle (issued, verified, failed, expired, invalidated), authentication success/failure, user creation/login
- **Storage**: Audit events are persisted to the `AuditLog` table in the database
- **Configuration**: Controlled by `AUDIT_LOG_DATABASE_ENABLED` (default: `true`)
- **Fallback**: When database persistence is disabled, events are only logged to Winston (files/console)

#### Retention Policies

The retention service automatically cleans up old data based on configurable time-to-live (TTL) policies:

| Entity          | Environment Variable                 | Default TTL | Purpose                                          |
| --------------- | ------------------------------------ | ----------- | ------------------------------------------------ |
| Auth Challenges | `RETENTION_AUTH_CHALLENGES_TTL_DAYS` | 7 days      | Remove expired and old authentication challenges |
| Chat Messages   | `RETENTION_CHAT_MESSAGES_TTL_DAYS`   | 90 days     | Archive old chat messages                        |
| Audit Logs      | `RETENTION_AUDIT_LOGS_TTL_DAYS`      | 90 days     | Maintain security audit trail for compliance     |

**Configuration**:

- Enable/disable each policy via `RETENTION_*_ENABLED` (default: `true`)
- Batch size for deletion operations: `RETENTION_BATCH_SIZE` (default: 1000)
- Retention service can be run on-demand or via cron scheduler

**Implementation**: See [src/services/retention.service.ts](src/services/retention.service.ts)

See [prisma/schema.prisma](prisma/schema.prisma) for full schema.

---

## Prerequisites

- **Node.js** 22.x or higher
- **npm**, **pnpm**, or **yarn**
- **PostgreSQL** database (local or cloud-hosted)
- **Stellar account** with testnet/mainnet keypairs (for admin & oracle roles)
- **@tevalabs/xelma-bindings** package (installed automatically)

---

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/TevaLabs/Xelma-Backend.git
cd Xelma-Backend
```

### 2. Install Dependencies

```bash
npm install
# or
pnpm install
# or
yarn install
```

This installs all dependencies including `@tevalabs/xelma-bindings`.

### 3. One-Command Local Infra (Docker Compose)

For contributors running **full backend mode** with PostgreSQL and Redis, use Docker Compose:

```bash
cp .env.docker.example .env
# Edit .env and set JWT_SECRET at minimum

docker compose up --build
```

| Service          | Port   | Health check                                  | Mode            |
| ---------------- | ------ | --------------------------------------------- | --------------- |
| API              | `3000` | `GET http://localhost:3000/health`             | Full (default)  |
| PostgreSQL       | `5432` | `pg_isready -U xelma -d xelma`                | —               |
| Redis            | `6379` | `redis-cli ping`                               | —               |

The API container runs `prisma migrate deploy` on startup before booting the server.
Redis is part of the default stack (used by the Socket.IO adapter and the
distributed idempotency locks described below); the API service waits for it
to be healthy before starting.

#### Docker entrypoint modes

The container entrypoint reads `API_MODE` to select which compiled binary to start:

| `API_MODE`    | Binary started       | Default port | Health probe path    | Use when                                    |
| ------------- | -------------------- | ------------ | -------------------- | ------------------------------------------- |
| _(unset)_     | `dist/index.js`     | `3000`       | `GET /health`        | Full production backend (default)           |
| `hackathon`   | `dist/server.js`    | `3001`       | `GET /api/health`    | Demo / hackathon — mock data, no DB needed  |

The entrypoint automatically sets `HEALTHCHECK_PATH` to match the selected mode,
so the Dockerfile `HEALTHCHECK` directive works without manual overrides. You can
also set `HEALTHCHECK_PATH` explicitly when running a standalone container:

```bash
# Full mode (default)
docker build -t xelma-api .
docker run -p 3000:3000 --env-file .env xelma-api

# Hackathon mode
docker run -p 3001:3001 -e API_MODE=hackathon xelma-api
```

To run the **hackathon mode** via Docker Compose (no database required, mock data only):

```bash
docker compose --profile hackathon up
```

The hackathon service maps port `3001` and sets `API_MODE=hackathon` + `HEALTHCHECK_PATH=/api/health` automatically.

**Troubleshooting Docker setup**

| Symptom                       | Fix                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `api` exits immediately       | Ensure `.env` exists and `JWT_SECRET` is set                                                               |
| `Can't reach database server` | Wait for `postgres` health check to pass; confirm `DATABASE_URL` uses host `postgres` inside Compose       |
| Port `3000` already in use    | Change `PORT` in `.env` and map `3001:3001` (or similar) in `docker-compose.yml`                           |
| Migrations fail on first boot | Run `docker compose logs api`; verify Postgres is healthy with `docker compose ps`                         |
| Redis connection warnings     | Confirm Redis is healthy (`docker compose ps`) and `REDIS_URL` points at `redis://redis:6379` inside Compose |
| Container reports unhealthy   | Verify `HEALTHCHECK_PATH` matches the mode (`/health` for full, `/api/health` for hackathon); check `docker inspect <container>` |

---

## Environment Setup

### 1. Copy Environment Template

```bash
cp .env.example .env
```

For hackathon/demo mode (mock data, minimal config):

```bash
cp .env.hackathon.example .env
```

### 2. Configure Environment Variables

See [`.env.example`](.env.example) for the full list of configurable variables. At minimum, set `DATABASE_URL` and `JWT_SECRET` before starting the server.

#### Price Oracle Tuning

Operators can tune the oracle's behavior via environment variables to balance price freshness against API rate limits and network reliability:

| Variable                        | Description                                  | Default       |
| :------------------------------ | :------------------------------------------- | :------------ |
| `ORACLE_POLLING_INTERVAL_MS`    | How often to fetch the price from CoinGecko. | `10000` (10s) |
| `ORACLE_REQUEST_TIMEOUT_MS`     | Network timeout for the API request.         | `5000` (5s)   |
| `ORACLE_MAX_RETRIES`            | Number of retry attempts on failure.         | `3`           |
| `ORACLE_STALENESS_THRESHOLD_MS` | When to consider the local price data stale. | `60000` (60s) |

> `ORACLE_STALENESS_THRESHOLD_MS` **must be greater than** `ORACLE_POLLING_INTERVAL_MS`,
> otherwise a freshly-fetched price would be classified as stale immediately after
> every poll. This invariant is enforced at startup by config validation.

##### Settlement staleness guard

Round resolution must never settle against a frozen or broken price feed. When a
process is actively polling the oracle, `resolutionService.resolveRound` refuses to
settle while the price is stale â€” this protects **both** the automated resolve loop
(`oracle.service.ts`) **and** the manual oracle/admin `POST /api/rounds/:id/resolve`
route, which then returns `503 EXTERNAL_SERVICE_ERROR`. Blocked attempts increment
`oracle_resolve_blocked_total` and are logged. Processes that do not poll the oracle
(e.g. `API_ONLY=true` HTTP nodes, or the test environment) cannot assess freshness
and defer the guard to the background worker that owns polling. Live oracle freshness
is observable at `GET /health` (`services.oracle`) and via the `oracle_*` metrics.

#### Bet Mode (`BET_STUB_MODE`)

| Variable        | Description                                                                                                       | Default |
| :-------------- | :---------------------------------------------------------------------------------------------------------------- | :------ |
| `BET_STUB_MODE` | `true` = stub mode (bets recorded locally, no on-chain calls); `false` = bets submitted to Soroban smart contract | `true`  |

#### Distributed idempotency lock tuning

| Variable                              | Purpose                                                                                | Default |
| :------------------------------------ | :------------------------------------------------------------------------------------- | :------ |
| `IDEMPOTENCY_LOCK_TTL_SECONDS`         | How long the Redis lock is held before auto-expiring (safety net)                      | `30`    |
| `IDEMPOTENCY_LOCK_ACQUIRE_TIMEOUT_MS`  | How long to wait for a lock held by another in-flight request before returning 409     | `10000` |
| `IDEMPOTENCY_LOCK_RETRY_DELAY_MS`      | Delay between lock acquisition attempts                                                 | `100`   |

#### Database pool/timeout tuning

Prismaâ€™s Postgres connector reads pool/timeouts via connection string query params. This backend exposes operational knobs as env vars and merges them into `DATABASE_URL` at startup (env vars win over existing query params):

| Variable                     | Purpose                                      | Default |
| ---------------------------- | -------------------------------------------- | ------- |
| `DB_CONNECTION_LIMIT`        | Max Prisma DB connections                    | `10`    |
| `DB_POOL_TIMEOUT_SECONDS`    | Wait for a pooled connection                 | `10`    |
| `DB_CONNECT_TIMEOUT_SECONDS` | Timeout establishing a new connection        | `10`    |
| `DB_STATEMENT_TIMEOUT_MS`    | Server-side statement timeout (`0` disables) | `0`     |
| `DB_PGBOUNCER`               | Enable PgBouncer transaction-pooling mode    | `false` |

**Notes**

- **PgBouncer**: if your stack uses PgBouncer in _transaction pooling_ mode, set `DB_PGBOUNCER=true`.
- **Visibility**: scrape `/metrics` and look for `db_pool_settings_info` to see the effective values.
- **Validation**: invalid values are rejected at startup via config validation.

#### Metrics contract

`GET /metrics` exposes Prometheus text-format metrics with only
low-cardinality labels. Labels intentionally avoid user IDs, wallet addresses,
round IDs, socket IDs, request bodies, and secrets.

For ready-to-use Prometheus alert rules covering oracle freshness, Soroban RPC,
and circuit-breaker health, see the [Prometheus alerts cookbook](docs/prometheus-alerts-cookbook.md).

> **Running more than one replica?** Cron jobs elect a single leader per tick
> via Redis. Every replica must share one `REDIS_URL`, or round creation and
> oracle resolution will run on all of them at once. See
> **[docs/multi-instance-deployment.md](docs/multi-instance-deployment.md)**
> for configuration, lock TTLs, alerts, and Render setup.

Core application metrics include:

| Metric                                 | Labels                           | Meaning                                                                           |
| -------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------- |
| `http_requests_total`                  | `method`, `route`, `status_code` | HTTP request volume by normalized Express route                                   |
| `http_request_duration_seconds`        | `method`, `route`, `status_code` | HTTP latency histogram                                                            |
| `http_errors_total`                    | `method`, `route`, `status_code` | HTTP 4xx/5xx responses                                                            |
| `predictions_placed_total`             | none                             | Successful prediction submissions                                                 |
| `rounds_started_total`                 | `mode`                           | Rounds created by game mode                                                       |
| `rounds_resolved_total`                | `mode`                           | Rounds resolved by game mode                                                      |
| `price_oracle_updates_total`           | `provider`                       | Successful oracle price refreshes                                                 |
| `price_oracle_fetch_failures_total`    | `reason`, `provider`             | Oracle refresh failures                                                           |
| `oracle_up`                            | none                             | `1` when the oracle is polling and holds a fresh price, else `0`                  |
| `oracle_last_update_timestamp_seconds` | none                             | Unix time of the last successful price update (`0` if never)                      |
| `oracle_price_staleness_seconds`       | none                             | Age of the current price in seconds (`-1` if no price yet)                        |
| `oracle_resolve_blocked_total`         | `reason`                         | Resolve attempts blocked by oracle safety guards (`stale_price`, `invalid_price`) |
| `scheduler_runs_total`                 | `job`, `outcome`                 | Scheduler executions                                                              |
| `scheduler_items_processed_total`      | `job`, `outcome`                 | Items processed by scheduler jobs                                                 |
| `distributed_lock_acquisitions_total`  | `lock`, `outcome`                | Scheduler leader election: `acquired`, `denied`, `unavailable`, `unlocked`         |
| `distributed_lock_renewals_total`      | `lock`, `outcome`                | Lock heartbeat renewals: `renewed`, `stolen`, `expired`, `error`                   |
| `distributed_lock_lost_total`          | `lock`, `reason`                 | Locks lost mid-job: `stolen`, `expired`, `redis_error`, `max_hold_exceeded`        |
| `distributed_locks_held`               | `lock`                           | Locks currently held by this instance                                             |
| `distributed_lock_held_seconds`        | `lock`                           | Lock hold duration, for tuning TTLs against real job duration                      |
| `socket_connections_active`            | none                             | Current Socket.IO connections                                                     |
| `websocket_emits_total`                | `event`, `outcome`               | WebSocket dispatch attempts                                                       |
| `websocket_connection_events_total`    | `event`, `authenticated`         | Socket connect/disconnect events                                                  |

### 3. Set Up Database

```bash
# Generate the Prisma client and apply ALL committed migrations
npm run db:prepare

# Create a new development migration when changing prisma/schema.prisma
npm run prisma:migrate

# (Optional) Seed database with sample data
npm run db:seed
```

#### Migration story (one schema, one command)

This project uses **Prisma as the single migration tool** against the PostgreSQL database:

| Tool        | Owns                                                                                                                       | Migrations live in   | Applied by              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------- |
| **Prisma**  | Core and hackathon schemas — users, rounds, predictions, tournaments, and mock data tables | `prisma/migrations/` | `prisma migrate deploy` |

`npm run db:migrate` applies all committed Prisma migrations, and `npm run db:prepare` generates the Prisma client before applying them. These are the same commands used by CI and deploy workflows, keeping local, CI, and production setup identical. When you change [prisma/schema.prisma](prisma/schema.prisma), use `npm run prisma:migrate`.

> **Note**: Never commit your `.env` file. It contains sensitive credentials.

---

## Running the Server

### Development Mode (with hot-reload)

```bash
npm run dev
```

Starts the **production app** (`src/index.ts`) on `http://localhost:3001` with auto-reload. This is the right server for all feature work and bug fixes. Requires `.env` with at least `DATABASE_URL` and `JWT_SECRET` (copy `.env.example` to get started).

```bash
# Demo server â€” no database required, mock data only
npm run dev:hackathon
```

### Production Mode

```bash
# Build TypeScript to JavaScript
npm run build

# Start production server (dist/index.js — matches the Render production profile)
npm start
```

To run the hackathon/demo server instead (`dist/server.js` — matches the
Render hackathon profile), use `npm run start:hackathon` after building.

### Render Parity Local Profile

To reproduce the runtime behavior of the Render deployment on your machine,
use the `start:render-parity` script. This sets `NODE_ENV=production`
before launching the built server so the same code paths Render hits
fire locally â€” CORS is strict (`CLIENT_URL` must be set, no wildcard
origin), error responses match production, and logging runs at
production verbosity.

```bash
# 1) Build first (start:render-parity expects dist/)
npm run build

# 2) Run with production-shaped environment
CLIENT_URL=http://localhost:5173 \
JWT_SECRET="$(openssl rand -base64 32)" \
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/xelma_local" \
npm run start:render-parity
```

Required env vars for parity (matches what Render's environment supplies):

| Variable                                                                 | Why it matters in render-parity mode                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `NODE_ENV=production`                                                    | Set by the script. Enables strict CORS and production logging. |
| `CLIENT_URL`                                                             | **Required.** Strict CORS will reject all origins if unset.    |
| `ALLOWED_ORIGINS`                                                        | Optional comma-separated extra origins.                        |
| `JWT_SECRET`                                                             | Required for startup. Use a cryptographically strong value.    |
| `DATABASE_URL`                                                           | Required. Point at a local Postgres.                           |
| `SOROBAN_CONTRACT_ID` / `SOROBAN_ADMIN_SECRET` / `SOROBAN_ORACLE_SECRET` | Optional; only needed if you want on-chain calls.              |

If you hit a CORS error from your frontend in this mode, hit
`GET /api/admin/cors-diagnostics?origin=<your-origin>` with an admin
token to see exactly which origins this process accepts.

### Verify Server is Running

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{
  "status": "healthy",
  "uptime": 42.123,
  "timestamp": "2026-02-23T12:00:00.000Z"
}
```

---

### Dead-Letter Queue

Notification creation and WebSocket emits go through a dead-letter queue
(DLQ) so a transient DB blip, a not-yet-initialized socket layer, or a
runtime exception in `emit` does not silently drop a user-facing event.

How it works:

- `notificationService.createNotification(...)` records a `FailedDispatch`
  row on `NOTIFICATION_CREATE` errors (the original error still rethrows
  so callers behave the same).
- `websocketService.emit*(...)` records a `FailedDispatch` row whenever
  the socket layer is not initialized or the underlying `emit` throws.
  The emit itself is fire-and-forget â€” the caller's hot path is never
  broken by a DLQ persistence failure.
- Rows have `attempts`, `lastError`, and `status` (`PENDING`, `RETRYING`,
  `RESOLVED`, `ABANDONED`) so an operator can triage stuck dispatches.

Operator endpoints (admin-only, gated by `requireAdmin`):

- `GET  /api/admin/dead-letter` â€” list entries, newest first. Query
  params: `status`, `channel`, `limit`, `offset`.
- `POST /api/admin/dead-letter/:id/retry` â€” replay a single entry; sets
  `RESOLVED` on success, bumps `attempts` and moves to `ABANDONED` once
  the cap (default 5) is reached.
- `POST /api/admin/dead-letter/retry-all` â€” replay every `PENDING` /
  `RETRYING` entry (capped, oldest first). Returns a counts summary.

---

## API Versioning

The current versioned base URL is `/api/v1`.

All endpoints are accessible under both `/api/v1/*` (versioned) and `/api/*` (legacy alias). The legacy paths (`/api/*`) are deprecated and will be removed on **2027-01-01**.

Clients should migrate to `/api/v1/*` before that date.

Responses from the deprecated legacy paths include the following headers:

- `Deprecation: true`
- `Sunset: Sat, 01 Jan 2027 00:00:00 GMT`
- `Link: </api/v1{path}>; rel="successor-version"`

---

## API Documentation

The backend provides auto-generated **OpenAPI/Swagger** documentation.

- **Swagger UI**: [http://localhost:3000/api-docs](http://localhost:3000/api-docs)
- **OpenAPI JSON**: [http://localhost:3000/api-docs.json](http://localhost:3000/api-docs.json)

### Monetary field contract (breaking)

Balances, stakes, payouts, pools, and tournament fees/prizes are **decimal
strings** with 8 fractional digits (`"1000.33333333"`), never JSON numbers.
See [docs/client-migration-money-strings.md](docs/client-migration-money-strings.md)
for the frontend migration note.

### Authentication Endpoints

#### Request Challenge

```bash
POST /api/auth/challenge
Content-Type: application/json

{
  "walletAddress": "GXXX...YOUR_STELLAR_ADDRESS"
}
```

**Response:**

```json
{
  "challenge": "random-challenge-string",
  "expiresAt": "2026-02-23T00:05:00.000Z"
}
```

#### Connect (Verify Signature)

```bash
POST /api/auth/connect
Content-Type: application/json

{
  "walletAddress": "GXXX...YOUR_STELLAR_ADDRESS",
  "challenge": "random-challenge-string",
  "signature": "BASE64_SIGNATURE_OF_CHALLENGE"
}
```

**Response:**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "user-uuid",
    "walletAddress": "GXXX...",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "lastLoginAt": "2026-02-23T12:00:00.000Z"
  },
  "bonus": 100,
  "streak": 1
}
```

---

### Round Management

#### Start a New Round (Admin Only)

```bash
POST /api/rounds/start
Authorization: Bearer YOUR_JWT_TOKEN
Content-Type: application/json

{
  "mode": 0,           # 0 = UP_DOWN, 1 = LEGENDS
  "startPrice": 0.1234,
  "duration": 300      # Duration in seconds
}
```

**Response:**

```json
{
  "success": true,
  "round": {
    "id": "round-uuid",
    "mode": "UP_DOWN",
    "status": "ACTIVE",
    "startPrice": 0.1234,
    "startTime": "2026-02-23T12:00:00Z",
    "endTime": "2026-02-23T12:05:00Z",
    "sorobanRoundId": "1",
    "poolUp": 0,
    "poolDown": 0
  }
}
```

#### Get Active Rounds

```bash
GET /api/rounds/active
```

**Response:**

```json
{
  "rounds": [
    {
      "id": "round-uuid",
      "mode": "UP_DOWN",
      "status": "ACTIVE",
      "startPrice": 0.1234,
      "startTime": "2026-02-23T12:00:00Z",
      "endTime": "2026-02-23T12:05:00Z",
      "poolUp": 150,
      "poolDown": 200
    }
  ]
}
```

---

### Prediction Endpoints

#### Submit a Prediction

```bash
POST /api/predictions/submit
Authorization: Bearer YOUR_JWT_TOKEN
Content-Type: application/json
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000

# For UP_DOWN mode:
{
  "roundId": "round-uuid",
  "amount": 10,
  "side": "UP"
}

# For LEGENDS mode:
{
  "roundId": "round-uuid",
  "amount": 10,
  "priceRange": {
    "min": 0.12,
    "max": 0.13
  }
}
```

`Idempotency-Key` is optional but recommended for clients that may retry a
submit request after network failure. The same authenticated user can retry the
same request body with the same key for 10 minutes and receive the cached
response. Reusing the same key with a different request body returns `409` with
code `IDEMPOTENCY_KEY_CONFLICT`; generate a fresh key for a new prediction
attempt.

**Response:**

```json
{
  "success": true,
  "prediction": {
    "id": "prediction-uuid",
    "roundId": "round-uuid",
    "amount": 10,
    "side": "UP",
    "priceRange": null,
    "createdAt": "2026-02-23T12:01:00Z"
  }
}
```

---

### Bet Endpoints

#### Submit an UP/DOWN Bet

```bash
POST /api/bets/up-down
Authorization: Bearer YOUR_JWT_TOKEN
Content-Type: application/json
Idempotency-Key: a5b7-c9d8-e2f4-77a8-33b2

{
  "address": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  "amount": 10,
  "side": "UP"
}
```

**Response:**

```json
{
  "success": true,
  "message": "Bet recorded (stub)",
  "state": "stub"
}
```

#### Submit a Precision Bet

```bash
POST /api/bets/precision
Authorization: Bearer YOUR_JWT_TOKEN
Content-Type: application/json
Idempotency-Key: a5b7-c9d8-e2f4-77a8-33b2

{
  "address": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  "amount": 5,
  "predictedPrice": 0.12
}
```

**Response:**

```json
{
  "success": true,
  "message": "Bet placed on-chain",
  "state": "on-chain-success",
  "txHash": "0x123..."
}
```

#### Bet Creation Idempotency

Both `/api/bets/up-down` and `/api/bets/precision` endpoints support safe client retries using the optional `Idempotency-Key` header.

- **Idempotency-Key Header**: Optional. Standard string format (alphanumeric with hyphens/underscores, 8-255 characters).
- **TTL (Time-To-Live)**: 24 hours. Stored idempotency records are kept for 24 hours (or as configured via `BET_IDEMPOTENCY_TTL_HOURS` environment variable) and then pruned by the daily scheduler.
- **Retry Semantics**:
  - **First Successful Request**: Performs the bet operation (either stub or submits on-chain) and caches the response.
  - **Duplicate Request (Same Key & Body)**: Returns the original cached response with HTTP 200 without creating a duplicate bet or executing on-chain transactions again.
  - **Mutation Check (Same Key, Different Body)**: Returns HTTP 409 Conflict with code `CONFLICT` and error code `IDEMPOTENCY_KEY_CONFLICT` to protect against unintentional reuse of keys across different operations.
  - **Concurrency Protection**: Simultaneous concurrent requests with the identical key are coordinated by a two-layer mechanism. A Redis distributed lock keyed by `userId + endpoint + idempotencyKey` (see [Distributed idempotency locking](#distributed-idempotency-locking)) serializes the race across all API replicas first; the existing database-level lock (`prisma.idempotencyKey` row) remains the source of truth underneath. Only one request executes the operation; every other concurrent retry waits for the lock, then replays the stored database response. This prevents double-betting even when multiple horizontally-scaled replicas receive the same `Idempotency-Key` simultaneously.
  - **Failures/Retries**: If the initial operation fails (e.g., Soroban network error or database timeout), the temporary lock is automatically released, allowing subsequent retries to execute the bet again instead of caching a failed state.

#### Distributed idempotency locking (multi-replica)

Bet routes (`/api/bets/up-down`, `/api/bets/precision`, `/api/bets/claim`) take
an optional `Idempotency-Key` header. When present, the request **must** first
acquire a Redis distributed lock before the database idempotency flow runs:

- **Lock key**: `xelma:idempotency-lock:{userId}:{endpoint}:{idempotencyKey}`.
- **Acquisition**: atomic `SET key token NX EX <ttl>` (30s default, configurable via `IDEMPOTENCY_LOCK_TTL_SECONDS`), retried while another replica holds the lock.
- **Release**: Lua owner-check (`GET` matches token before `DEL`) so a stale holder can never delete a newer owner's lock. Release is best-effort; the TTL bounds the lock if the process dies mid-request.
- **Fail-closed policy**: Redis is a hard dependency for bets that carry an `Idempotency-Key`. If Redis is unreachable, not configured, or a lock command fails, the request is rejected with HTTP 503 (`EXTERNAL_SERVICE_ERROR`) and **no bet is processed** — there is deliberately no fallback to DB-only locking, because Prisma-only locking is not safe under multi-replica + store-latency conditions. If the lock stays held by another in-flight request past `IDEMPOTENCY_LOCK_ACQUIRE_TIMEOUT_MS` (default 10s), the request is rejected with HTTP 409 (`IDEMPOTENCY_KEY_CONFLICT`).
- **Requests without an `Idempotency-Key`** are unaffected and never touch the lock (there is no idempotency protection to serialize for them).

---

### Leaderboard & User Stats

#### Get Global Leaderboard

```bash
GET /api/leaderboard?limit=100&offset=0
```

**Response:**

```json
{
  "leaderboard": [
    {
      "rank": 1,
      "userId": "user-uuid",
      "walletAddress": "GXXX...XXXX",
      "totalEarnings": 5432.1,
      "totalPredictions": 60,
      "accuracy": 75.0,
      "modeStats": {
        "upDown": {
          "wins": 30,
          "losses": 15,
          "earnings": 3000.0,
          "accuracy": 66.67
        },
        "legends": {
          "wins": 15,
          "losses": 0,
          "earnings": 2432.1,
          "accuracy": 100.0
        }
      }
    }
  ],
  "userPosition": null,
  "totalUsers": 150,
  "lastUpdated": "2026-02-23T12:00:00.000Z"
}
```

---

### WebSocket Events

Connect to the WebSocket server with JWT authentication:

```javascript
import io from "socket.io-client";

const socket = io("http://localhost:3000", {
  auth: {
    token: "YOUR_JWT_TOKEN",
  },
});

// Listen for price updates
socket.on("price_update", (data) => {
  console.log("New price:", data);
  // { asset: 'XLM', price: 0.1234, timestamp: '...' }
});

// Listen for round updates
socket.on("round_update", (data) => {
  console.log("Round update:", data);
  // { type: 'created'|'locked'|'resolved', round: {...} }
});

// Listen for balance updates
socket.on("user_balance_update", (data) => {
  console.log("Balance update:", data);
  // { userId: '...', balance: 1050 }
});

// Listen for notifications
socket.on("new_notification", (notification) => {
  console.log("Notification:", notification);
});

// Listen for chat messages
socket.on("new_message", (message) => {
  console.log("Chat:", message);
});

// Listen for accepted bets (stub or on-chain) — join the `round` room first
socket.on("bet:accepted", (data) => {
  console.log("Bet accepted:", data);
  // {
  //   roundId?: string,
  //   address: string,
  //   amount: number,
  //   side?: 'UP' | 'DOWN',
  //   mode: 'UP_DOWN' | 'PRECISION',
  //   state: 'stub' | 'on-chain-success',
  //   txHash?: string
  // }
});
```

## See also [`src/docs/websocket.md`](src/docs/websocket.md) for the Socket.IO client contract.

## Testing

Run the test suite with Jest:

```bash
# Run all tests (unit + integration)
npm test

# Run unit tests only
npm run test:unit

# Run unit tests with coverage thresholds
npm run test:unit:coverage

# Run integration tests only (requires PostgreSQL â€” see DATABASE_URL in .env)
npm run test:integration

# Run all tests with coverage
npm run test:coverage

# Run tests in watch mode (development)
npm run test:watch

# Run the full local CI check (lint + build + unit coverage + integration)
npm run ci

# Run the legacy hackathon node:test suite
npm run test:hackathon

# Run load/performance baselines
npm run test:load
```

### Redis Socket.IO adapter integration test

src/tests/redis-adapter.spec.ts proves that Socket.IO room broadcasts fan out across two independent server instances via the Redis adapter (simulating a multi-instance deployment). It is skipped automatically when REDIS_URL is not set, so it never blocks the default unit test run.

### Distributed idempotency lock tests (Issue #493)

`src/tests/bets-idempotency-concurrency.spec.ts` races 12 concurrent requests
carrying the same `Idempotency-Key` against the real Prisma store + real Redis
and asserts exactly one bet is accepted while every other response replays the
stored result. `src/tests/bets-idempotency-redis-outage.spec.ts` points the
shared Redis client at an unreachable address and asserts bet requests fail
closed with HTTP 503, recording nothing. Both are integration tests and require
PostgreSQL + Redis:

```bash
docker compose up -d postgres redis
npm run test:integration
```

To run it locally:

```bash
docker compose up -d redis
REDIS_URL=redis://localhost:6379 npx jest --testPathPattern=redis-adapter
```

Coverage thresholds are enforced in `jest.config.ts`. The current floors are:

- Branches: 70%
- Functions: 50%
- Lines: 35%
- Statements: 35%

CI runs `npm run test:unit:coverage` (unit tests with coverage upload) and `npm run test:integration` (integration tests against PostgreSQL and Redis service containers) as separate parallel jobs.

### Load test harness

`npm run test:load` runs the Jest performance suite (`performance.spec.ts` and
`performance-backpressure.spec.ts`). It is **manual** on every PR and also runs
on a **nightly** GitHub Actions workflow (`.github/workflows/load-test.yml`).

Scenarios:

- **Latency baselines** for auth, active rounds, and prediction submit (#152).
- **Concurrent prediction throughput** with aggregate RPS and p95 latency.
- **Authenticated bets** — concurrent `POST /api/bets/up-down` (#500).
- **Duplicate idempotency** — same `Idempotency-Key` burst; only one bet is created (#500).
- **Read rounds** — concurrent `GET /api/rounds/active` (#500).
- **Overload** — burst bets against the real rate limiter; expect **429**, never 500 (#500).
- **Breaker mapping** — open circuit / in-flight cap map to **503** + `Retry-After` (#500).
- **WebSocket fanout** — connected clients receive `prediction:placed` within the p95 budget.

The harness lives in `src/tests/load-test.harness.ts`. Throughput tests mock
Prisma/Soroban so they stay repeatable without a live database. Overload tests
keep the real rate limiters. Tune thresholds via env vars (see `.env.example`).

#### Demo vs production defaults

| Knob                             | Demo (default)       | Production                           |
| -------------------------------- | -------------------- | ------------------------------------ |
| `BET_STUB_MODE`                  | `true`               | `false`                              |
| `SOROBAN_FAIL_CLOSED`            | `false`              | `true`                               |
| Bet rate limit                   | 5 / minute / IP      | same until a live run says otherwise |
| Prediction submit                | 10 / minute / user   | same                                 |
| Write methods (hackathon global) | 20 / minute / IP     | same                                 |
| Soroban breaker                  | 3 failures, 30s open | same                                 |
| Soroban in-flight cap            | 8                    | 8–16 after measuring RPC p95         |

Do not raise these because a demo felt slow. Raise them only after `npm run test:load` (and a staging burst) shows p95 and error rate staying inside budget.

Each run prints `[LOAD]` summary lines to stdout for before/after comparisons in PRs.

Example (local, mocked Prisma — numbers vary by machine):

```
[LOAD] auth bet throughput
  total=16 success=16 fail=0 errorRate=0.0%
  latency ms: p50=... p95=... p99=...
[LOAD] bet overload 429
  statuses: 200xN 429xM
```

Coverage thresholds are enforced in `jest.config.ts` for lines, branches, functions, and statements. The current floor is intentionally conservative and excludes tests, mocks, generated files, scripts, and vendored bindings so the gate tracks application code. CI runs `npm run test:unit:coverage`, prints the Jest coverage summary, uploads `coverage/`, and fails when the thresholds are not met.

Current test coverage includes:

- Education tip service tests
- Education tip route tests
- Round service tests

---

## Migration Safety

Schema changes should follow the migration checklist in [docs/migration-safety.md](docs/migration-safety.md). Use it before opening PRs that edit `prisma/schema.prisma`, add files under `prisma/migrations/`, or require production backfills.

At minimum, migration PRs should include:

- A before/after behavior summary.
- Risk notes for locks, backfills, and compatibility with the previous application version.
- Verification output for Prisma generation, migration, and targeted tests.
- A rollback plan that preserves production data.

---

## Scripts

| Script                          | Description                                                                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm start`                     | Run **production** full backend (`dist/index.js` — Prisma, Soroban, schedulers, WebSocket); this is the default Render start command for the `xelma-backend` profile (requires build). Alias for `npm run start:full` |
| `npm run start:full`            | Explicit alias for `npm start` — run the production full backend (`dist/index.js`)                                                                                                                                    |
| `npm run start:hackathon`       | Run the hackathon/demo server (`dist/server.js`); this is the Render start command for the `xelma-backend-hackathon` profile (requires build)                                                                         |
| `npm run dev`                   | Start the **production** development server (`src/index.ts`) with hot-reload — use this for all feature work                                                                                                          |
| `npm run dev:hackathon`         | Start the hackathon demo server (`src/server.ts`) — mock data only, no database required                                                                                                                              |
| `npm run build`                 | Compile TypeScript to JavaScript                                                                                                                                                                                      |
| `npm test`                      | Run Jest test suite                                                                                                                                                                                                   |
| `npm run test:coverage`         | Run Jest with coverage reporting and thresholds                                                                                                                                                                       |
| `npm run test:unit:coverage`    | Run unit tests with coverage reporting and thresholds                                                                                                                                                                 |
| `npm run test:watch`            | Run tests in watch mode                                                                                                                                                                                               |
| `npm run test:load`             | Run load baselines plus overload 429/503 backpressure checks                                                                                                                                                          |
| `npm run ci`                    | Run lint, build, unit coverage, and integration tests                                                                                                                                                                 |
| `npm run prisma:generate`       | Generate Prisma client                                                                                                                                                                                                |
| `npm run prisma:migrate`        | Run database migrations                                                                                                                                                                                               |
| `npm run db:seed:mock`          | Seed database with mock data                                                                                                                                                                                          |
| `node dist/index.js`            | Run production full backend (Prisma, Soroban, schedulers, WebSocket); use this command in production Render profile                                                                                                   |
| `npm run prisma:migrate`        | Create/apply a Prisma dev migration for the core schema                                                                                                                                                               |
| `npm run prisma:migrate:deploy` | Apply committed Prisma migrations without creating new ones                                                                                                                                                           |
| `npm run db:migrate`            | Apply all committed Prisma migrations                                                                                                                                                                                  |
| `npm run db:prepare`            | Generate the Prisma client, then run `db:migrate` (the one-command DB setup used by CI and deploys)                                                                                                                   |
| `npm run docs:openapi`          | Generate OpenAPI JSON spec to `docs/openapi.json`                                                                                                                                                                     |
| `npm run docs:verify`           | Regenerate OpenAPI and verify required paths are documented (CI gate)                                                                                                                                                 |
| `npm run scorecard`             | Run the production-readiness scorecard                                                                                                                                                                                |
| `npm run pr:publish`            | Push the fork branch and open/update a PR as **your** git/GitHub user, stripping Cursor co-author trailers                                                                                                            |

Do not use `gh pr create` from Cursor Agent — it appends “Made with Cursor” and injects a `Co-authored-by: Cursor` commit trailer. Stage your files, then run **node** (Windows `npm run` often swallows `--flags`):

```bash
git add -A
node scripts/publish-pr.js --title "Add load-test harness" --issue 500
node scripts/publish-pr.js --fix-existing
```

Or: `npm run pr:publish --fix-existing` / `npm run pr:publish --title="..." --issue=500` (equals-form flags). The script rewrites HEAD with `git commit-tree` (so Cursor cannot re-inject the trailer), force-with-lease pushes the `fork` remote, and creates or updates the upstream PR.

---

## Error Code Catalog

Every error response from the API carries a stable machine-readable
`code` (in addition to the HTTP status) so clients can branch on the
specific failure without parsing prose. The canonical list lives in
[`src/utils/errors.ts`](src/utils/errors.ts) as `ERROR_CATALOG` and is
also exposed as JSON at `GET /api/errors` for client codegen.

A drift test (`src/tests/error-catalog.spec.ts`) pins the catalog to
the `ErrorCode` enum, so adding a new code without a catalog entry
fails CI.

| HTTP | Code                      | Description                                                          |
| ---- | ------------------------- | -------------------------------------------------------------------- |
| 400  | `VALIDATION_ERROR`        | Body / query / params failed schema validation. See `error.details`. |
| 401  | `AUTHENTICATION_ERROR`    | Missing / invalid credentials. Re-authenticate.                      |
| 401  | `INVALID_CHALLENGE`       | Signed challenge does not match a known issued challenge.            |
| 401  | `CHALLENGE_EXPIRED`       | Challenge TTL elapsed. Request a new one.                            |
| 401  | `CHALLENGE_USED`          | Challenge already consumed (one-shot).                               |
| 401  | `INVALID_SIGNATURE`       | Signature does not verify against wallet + challenge.                |
| 403  | `AUTHORIZATION_ERROR`     | Authenticated, not permitted.                                        |
| 404  | `NOT_FOUND`               | Resource does not exist.                                             |
| 409  | `CONFLICT`                | Generic state conflict.                                              |
| 409  | `ROUND_ALREADY_RESOLVED`  | Round outcome already final.                                         |
| 409  | `DUPLICATE_PREDICTION`    | User already predicted on this round.                                |
| 409  | `ACTIVE_ROUND_EXISTS`     | A round of the requested mode is already active.                     |
| 422  | `BUSINESS_RULE_VIOLATION` | Generic domain rule violation.                                       |
| 422  | `INSUFFICIENT_FUNDS`      | Not enough balance.                                                  |
| 422  | `ROUND_NOT_ACTIVE`        | Round is not in `ACTIVE` status.                                     |
| 422  | `ROUND_LOCKED`            | Round is locked before resolution.                                   |
| 500  | `CONFIGURATION_ERROR`     | Server misconfiguration. Operator action required.                   |
| 500  | `INTERNAL_SERVER_ERROR`   | Unexpected. Retry; include `requestId` if reporting.                 |
| 503  | `EXTERNAL_SERVICE_ERROR`  | Upstream (DB, RPC, oracle) failure. Retry with backoff.              |

---

## Production-Readiness Scorecard

`npm run scorecard` runs a small, zero-dependency set of "is this repo
ready to deploy?" heuristics and prints a green / yellow / red
breakdown. CI runs the same script in its own job
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) and fails the
build only when a **required** check fails â€” soft "nice to have"
checks emit warnings without blocking merges. New checks live in
[`scripts/production-readiness-scorecard.js`](scripts/production-readiness-scorecard.js).

---

## Troubleshooting

### Soroban Service Disabled on Startup

**Error:**

```
Soroban configuration or bindings missing. Soroban integration DISABLED.
```

**Solution:**
Ensure your `.env` contains valid values for:

- `SOROBAN_CONTRACT_ID`
- `SOROBAN_ADMIN_SECRET`
- `SOROBAN_ORACLE_SECRET`

Verify the contract is deployed and accessible at `SOROBAN_RPC_URL`.

---

### Cannot Find Module '@tevalabs/xelma-bindings'

**Error:**

```
Cannot find module '@tevalabs/xelma-bindings'
```

**Solution:**

```bash
npm install @tevalabs/xelma-bindings
# or
npm install
```

---

### Database Connection Errors

**Error:**

```
Can't reach database server at localhost:5432
```

**Solution:**

1. Verify PostgreSQL is running: `psql -U postgres`
2. Check `DATABASE_URL` in `.env` matches your database credentials
3. Ensure database `xelma_db` exists or run migrations: `npm run prisma:migrate`

---

### JWT Authentication Failures (401 Unauthorized)

**Cause:** Token is missing, expired, or invalid.

**Solution:**

1. Ensure you're including the token in the `Authorization` header:
   ```
   Authorization: Bearer YOUR_JWT_TOKEN
   ```
2. If expired, log in again to get a fresh token
3. Verify `JWT_SECRET` in `.env` matches the one used to generate the token

---

### Forbidden Errors (403) for Admin/Oracle Routes

**Cause:** Your account doesn't have the required role.

**Solution:**

1. Check your user's role in the database (should be `ADMIN` or `ORACLE`)
2. Verify `SOROBAN_ADMIN_SECRET` and `SOROBAN_ORACLE_SECRET` in `.env` match the keypairs registered in the smart contract
3. Ensure you're using the correct JWT token for the intended role

---

### Price Oracle Not Updating

**Cause:** CoinGecko API rate limits or network issues.

**Solution:**

1. Check server logs for error messages from the oracle service
2. Verify internet connectivity
3. Consider using a CoinGecko API key if hitting rate limits (update `oracle.ts`)

---

### Round Scheduler Not Running

**Cause:** Scheduler is disabled in configuration.

**Solution:**
Set `ROUND_SCHEDULER_ENABLED=true` in `.env` and restart the server.

---

## CI/CD Pipeline

This project uses GitHub Actions for continuous integration and deployment. CI and CD are cleanly separated into two workflow files.

### Continuous Integration (CI)

**File:** `.github/workflows/ci.yml`

CI runs automatically on every pull request and on pushes to `main`. It executes three independent jobs in parallel:

| Job       | What it does                                                                                  |
| --------- | --------------------------------------------------------------------------------------------- |
| **lint**  | Runs `tsc --noEmit` to check for type errors                                                  |
| **build** | Compiles TypeScript to `dist/` via `tsc`                                                      |
| **test**  | Spins up a PostgreSQL 16 service container, runs migrations, and executes the full test suite |

CI is fast, deterministic, and has no side effects. It is also used as a gate by the deployment workflow.

### Deployment Workflow (CD)

**File:** `.github/workflows/deploy.yml`

The deployment workflow calls CI as a prerequisite (reusable workflow) and only proceeds if all checks pass.

#### Staging Deployment

- **Trigger:** Automatic on push to `dev` or `staging` branches, or via manual `workflow_dispatch`
- **Environment:** `staging` (configured in GitHub repository settings)
- **Process:**
  1. CI suite runs and must pass
  2. Dependencies are installed and the project is built
  3. Database migrations run against the staging database
  4. Application is deployed to the staging environment

#### Production Deployment

- **Trigger:** Push to `main` or manual `workflow_dispatch` with `production` selected
- **Environment:** `production` (configured in GitHub repository settings with **required reviewers**)
- **Approval Gate:** Production deployments require manual approval through GitHub's environment protection rules. Configure this in **Settings > Environments > production > Required reviewers**.
- **Process:**
  1. CI suite runs and must pass
  2. A reviewer must approve the deployment in the GitHub Actions UI
  3. Dependencies are installed and the project is built
  4. Database migrations run against the production database
  5. Application is deployed to production

#### Manual Deployment

Both environments can be deployed manually via **Actions > Deploy > Run workflow**, selecting the target environment from the dropdown.

### Environment Configuration

Each environment (`staging`, `production`) must have the following configured in **GitHub Settings > Environments**:

#### Required Secrets

| Secret                  | Description                                                      |
| ----------------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`          | PostgreSQL connection string for the target environment          |
| `JWT_SECRET`            | Strong random secret for JWT signing (must not be a placeholder) |
| `SOROBAN_CONTRACT_ID`   | Deployed Soroban prediction market contract address              |
| `SOROBAN_ADMIN_SECRET`  | Stellar secret key for contract admin operations                 |
| `SOROBAN_ORACLE_SECRET` | Stellar secret key for oracle price settlement                   |

#### Environment Variables (non-sensitive)

| Variable          | Description                               | Example                               |
| ----------------- | ----------------------------------------- | ------------------------------------- |
| `PORT`            | Server listen port                        | `3000`                                |
| `CLIENT_URL`      | CORS-allowed frontend origin              | `https://app.xelma.io`                |
| `SOROBAN_NETWORK` | Stellar network target                    | `testnet` or `mainnet`                |
| `SOROBAN_RPC_URL` | Soroban RPC endpoint                      | `https://soroban-testnet.stellar.org` |
| `STAGING_URL`     | Staging environment URL (display only)    | `https://staging.xelma.io`            |
| `PRODUCTION_URL`  | Production environment URL (display only) | `https://xelma.io`                    |

#### Setup Steps

1. Go to your repository **Settings > Environments**
2. Create `staging` and `production` environments
3. For `production`, enable **Required reviewers** and add authorized approvers
4. Add all secrets and variables listed above to each environment
5. Ensure no secrets contain placeholder values

### Rollback Procedure

If a deployment causes issues, use the following rollback process:

#### Quick Rollback (revert to previous deployment)

```bash
# 1. Identify the last known good commit
git log --oneline -10

# 2. Revert the problematic commit(s)
git revert <bad-commit-sha>

# 3. Push the revert (this triggers a new deployment)
git push origin main    # for production
git push origin dev     # for staging
```

#### Manual Rollback (redeploy a specific commit)

1. Go to **Actions > Deploy > Run workflow**
2. Select the target environment
3. Optionally, create a branch from the known-good commit and push it to trigger deployment

#### Database Rollback

If a migration caused the issue:

```bash
# Check migration status
npx prisma migrate status

# If needed, manually revert the migration in the target database
# Then redeploy the previous commit
```

**Important:** Always test rollbacks in staging before applying to production. Database migrations are not automatically reversed; plan migrations to be backward-compatible when possible.

---

## Render Deployment

The repository includes a [`render.yaml`](render.yaml) blueprint with two service profiles:

### Profile 1: Hackathon Demo (`xelma-backend-hackathon`)

| Setting           | Value                                                     |
| ----------------- | --------------------------------------------------------- |
| **Start command** | `npm run start:hackathon` (runs `dist/server.js`)         |
| **Health check**  | `GET /api/health`                                         |
| **Database**      | Not required â€” set `DATA_MODE=mock` for in-process data |
| **Plan**          | Free tier sufficient                                      |

Minimal env vars needed (all others use sensible defaults):

| Variable                    | Example                               | Purpose                                                            |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| `JWT_SECRET`                | _(sync on Render)_                    | Signs JWT tokens                                                   |
| `DATA_MODE`                 | `mock`                                | Use mock in-process data (no DB)                                   |
| `ENABLE_MULTIPLAYER_SOCIAL` | `true`                                | Enable chat / notifications                                        |
| `CLIENT_URL`                | `https://your-app.onrender.com`       | CORS origin                                                        |
| `SOROBAN_CONTRACT_ID`       | _(sync on Render)_                    | Soroban contract address (optional for demo; alias: `CONTRACT_ID`) |
| `SOROBAN_RPC_URL`           | `https://soroban-testnet.stellar.org` | Soroban RPC (alias: `STELLAR_RPC_URL`)                             |

### Profile 2: Production Full Backend (`xelma-backend`)

| Setting           | Value                                                               |
| ----------------- | ------------------------------------------------------------------- |
| **Start command** | `npm start` (runs `dist/index.js`)                                  |
| **Health check**  | `GET /health`                                                       |
| **Database**      | PostgreSQL required â€” migrations run automatically in build phase |
| **Plan**          | Starter or higher recommended                                       |

Required env vars:

| Variable                | Example / Purpose                                           |
| ----------------------- | ----------------------------------------------------------- |
| `DATABASE_URL`          | PostgreSQL connection string _(sync on Render)_             |
| `JWT_SECRET`            | Strong random secret _(sync on Render)_                     |
| `CLIENT_URL`            | Frontend origin for CORS                                    |
| `SOROBAN_CONTRACT_ID`   | Deployed prediction market contract _(sync on Render)_      |
| `SOROBAN_ADMIN_SECRET`  | Stellar secret key for admin ops _(sync on Render)_         |
| `SOROBAN_ORACLE_SECRET` | Stellar secret key for oracle settlement _(sync on Render)_ |

### Choosing a Profile

1. Go to **Dashboard > New > Blueprint** and connect your fork of this repo.
2. Render reads `render.yaml` and lists both services. Uncheck the profile you do **not** want to deploy.
3. For each selected service, fill in any `sync: false` env vars.
4. Deploy. The service is reachable at `https://<service-name>.onrender.com:<PORT>`.

> **Port note**: The server listens on the port defined by the `PORT` env var (default `3000`). Render automatically sets `PORT` in the runtime environment.

---

## Hackathon Quick-Start

This section is designed so a new developer can boot and test the API in minutes.

### Setup

```bash
git clone https://github.com/TevaLabs/Xelma-Backend.git
cd Xelma-Backend
npm install

# 1. Start PostgreSQL (if not running a local instance)
docker compose up -d postgres

# 2. Copy and customize environment variables
cp .env.hackathon.example .env
# Edit .env â†’ set DATABASE_URL and JWT_SECRET

# 3. Apply all database migrations
npm run db:prepare

# 4. Seed initial mock rounds and user data to Postgres
npx prisma db seed

# Optional: seed joinable demo tournaments for /api/tournaments
npm run db:seed:tournaments

# 5. Start the server
npm run dev
```

The server starts on `http://localhost:3001` (or the `PORT` in `.env`). See the [API Documentation](#api-documentation) section above for endpoint examples.

### Required Environment Variables

| Variable                    | Example                                                                       | Purpose                                                                    |
| --------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `PORT`                      | `3001`                                                                        | Server listen port                                                         |
| `DATABASE_URL`              | `postgresql://xelma:xelma@localhost:5432/xelma`                               | PostgreSQL connection                                                      |
| `JWT_SECRET`                | `my-secret-key`                                                               | Signs JWT tokens (app refuses to start without it)                         |
| `DATA_MODE`                 | `mock`                                                                        | Hackathon service data mode (set to `mock` to query Drizzle schema tables) |
| `ENABLE_MULTIPLAYER_SOCIAL` | `true`                                                                        | Feature flag to enable/disable chat and notifications routes               |
| `COINGECKO_API_URL`         | `https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd` | Price oracle source                                                        |
| `SOROBAN_RPC_URL`           | `https://soroban-testnet.stellar.org`                                         | Soroban RPC (alias: `STELLAR_RPC_URL`)                                     |
| `SOROBAN_CONTRACT_ID`       | _(your deployed contract)_                                                    | Soroban prediction market contract (alias: `CONTRACT_ID`)                  |

> **Note**: For the Hackathon MVP, the backend is fully migrated from in-memory arrays to PostgreSQL via Drizzle ORM for durable persistence of users, rounds, and bets. No in-memory stores are used.

### 3. Hackathon Endpoint Curl Examples

#### Health Check

```bash
curl http://localhost:3001/health
```

#### Get Multi-Asset Prices (hackathon)

```bash
curl http://localhost:3001/api/prices
```

> Use `/api/prices` on the hackathon app. `/api/price` is the **production-only** XLM oracle endpoint and is not mounted on port 3001.

#### Get XLM Oracle Price (production)

```bash
curl http://localhost:3000/api/price
```

#### Auth: Request Challenge

```bash
curl -X POST http://localhost:3001/api/auth/challenge \
  -H "Content-Type: application/json" \
  -d '{"walletAddress": "GXXX...YOUR_STELLAR_ADDRESS"}'
```

#### Auth: Connect (verify signature, get JWT)

```bash
curl -X POST http://localhost:3001/api/auth/connect \
  -H "Content-Type: application/json" \
  -d '{
    "walletAddress": "GXXX...YOUR_STELLAR_ADDRESS",
    "challenge": "CHALLENGE_FROM_ABOVE",
    "signature": "BASE64_SIGNATURE"
  }'
```

#### Get Active Rounds

```bash
curl http://localhost:3001/api/rounds/active
```

#### Get Round by ID

```bash
curl http://localhost:3001/api/rounds/ROUND_ID
```

#### Submit Prediction (requires JWT)

```bash
curl -X POST http://localhost:3001/api/predictions/submit \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT" \
  -d '{"roundId": "ROUND_ID", "amount": 10, "side": "UP"}'
```

#### Submit UP/DOWN Bet (requires JWT)

Wallet authentication uses the challenge/connect flow above. Bets are bound to the JWT wallet; unauthenticated attempts return `401`.

```bash
curl -X POST http://localhost:3000/api/bets/up-down \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT" \
  -d '{"amount": 10, "side": "UP"}'
```

```bash
# Unauthenticated â€” rejected
curl -X POST http://localhost:3000/api/bets/up-down \
  -H "Content-Type: application/json" \
  -d '{"amount": 10, "side": "UP"}'
```

#### Get User Profile (requires JWT)

```bash
curl http://localhost:3001/api/user/profile \
  -H "Authorization: Bearer YOUR_JWT"
```

#### Get User Balance (requires JWT)

```bash
curl http://localhost:3001/api/user/balance \
  -H "Authorization: Bearer YOUR_JWT"
```

#### Get User Stats (requires JWT)

```bash
curl http://localhost:3001/api/user/stats \
  -H "Authorization: Bearer YOUR_JWT"
```

#### Get Bet History by Address

```bash
curl "http://localhost:3001/api/user/GXXX.../history?limit=20&offset=0"
```

#### Get Public Profile

```bash
curl http://localhost:3001/api/user/GXXX.../public-profile
```

#### Get Wallet Stats (returns per-wallet stats from PostgreSQL, echoing the address param)

```bash
curl http://localhost:3001/api/user/GXXX.../stats
```

> **Note on Feature Flags**: Chat (`/api/chat/*`) and Notification (`/api/notifications/*`) endpoints are feature-gated behind the `ENABLE_MULTIPLAYER_SOCIAL` configuration option. If this option is set to `false`, these endpoints will return a `404 Not Found` JSON response.

#### Get Transactions (requires JWT)

```bash
curl "http://localhost:3001/api/user/transactions?page=1&limit=20" \
  -H "Authorization: Bearer YOUR_JWT"
```

#### Get Leaderboard

```bash
curl "http://localhost:3001/api/leaderboard?limit=10&offset=0"
```

#### List Tournaments

```bash
curl "http://localhost:3001/api/tournaments?limit=10&offset=0"
curl "http://localhost:3001/api/tournaments?mode=UP_DOWN"
curl "http://localhost:3001/api/tournaments?status=ACTIVE&mode=LEGENDS&limit=20&offset=0"
```

For a fresh local database with joinable demo tournaments, run:

```bash
npm run db:seed:tournaments
```

The seed is idempotent and upserts three stable tournament IDs covering `ACTIVE`, `UPCOMING`, and `COMPLETED` statuses across both `UP_DOWN` and `LEGENDS` modes.

#### Get Tournament Detail

```bash
curl http://localhost:3001/api/tournaments/t-001
```

#### Get Education Guides

```bash
curl http://localhost:3001/api/education/guides
```

#### Send Chat Message (requires JWT)

```bash
curl -X POST http://localhost:3001/api/chat/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT" \
  -d '{"content": "Hello everyone!"}'
```

#### Get Chat History

```bash
curl "http://localhost:3001/api/chat/history?limit=50"
```

#### Get Notifications (requires JWT)

```bash
curl "http://localhost:3001/api/notifications?limit=20&offset=0" \
  -H "Authorization: Bearer YOUR_JWT"
```

#### Swagger UI

Open [http://localhost:3001/api-docs](http://localhost:3001/api-docs) in a browser for interactive API documentation.

---

## ORM Decision (ADR-style) — Issue #391

**Status:** Accepted and implemented.

**Context**
The hackathon read/write paths now use Prisma (`prisma/schema.prisma`) for all
database access, including the
`Mock*` models (`MockRound`, `MockLeaderboard`, `MockPlatformStat`) that already
back the hackathon read endpoints (`/api/rounds`, `/api/leaderboard`, `/api/stats`)
via the repository layer. Running two migration/seed toolchains against one
database is exactly the "dual migrations, dual seeds, dual contributor setup"
problem described in #391 — a contributor could migrate one ORM's schema and
silently leave the other out of sync.

**Decision**
Standardize on **Prisma** as the single ORM for hackathon data going forward.
Prisma is already the ORM for every non-hackathon table and already has the
`Mock*` models used by the hackathon paths.

**Implementation**
`hackathon.service.ts` uses the existing Prisma-backed mock models:

- `MockLeaderboard` gained `balance` and `pendingWinnings` fields so it can
  represent the full hackathon user record (it previously only backed
  leaderboard reads).
- A new `MockBet` model replaces `hackathonBets`.
- All `db.select()/.insert()/.update()` calls in `hackathon.service.ts` are now
  `prisma.mockRound` / `prisma.mockLeaderboard` / `prisma.mockBet` calls.
- The public API of `HackathonService` (method signatures and return shapes)
  is unchanged, so `PrismaRoundRepository.placeBet` and `src/routes/user.ts`
  needed no changes.

The Prisma migration for the new `MockBet` model and `MockLeaderboard` columns
must be generated and applied against a real database with `npx prisma migrate dev`.

## Hackathon API Rate Limits

The lightweight hackathon server (default port **3001**) applies per-IP throttling with [`express-rate-limit`](https://github.com/express-rate-limit/express-rate-limit).

| Limiter            | Scope                            | Window   | Max requests |
| ------------------ | -------------------------------- | -------- | ------------ |
| `apiRateLimiter`   | All `/api/*` routes              | 1 minute | 100          |
| `writeRateLimiter` | `POST`, `PUT`, `PATCH`, `DELETE` | 1 minute | 20           |
| `betRateLimiter`   | `POST /api/rounds/:id/bet`       | 1 minute | 5            |

When a client exceeds a limit, the API returns **429** with retry guidance:

```json
{
  "error": "Too Many Requests",
  "message": "Too many bet submissions from this IP. Please wait before placing another bet.",
  "retryAfter": 60
}
```

The `RateLimit-*` and `Retry-After` response headers are also set (`standardHeaders: true`).

---

## Related Repositories

- **Smart Contract**: [TevaLabs/Xelma-Blockchain](https://github.com/TevaLabs/Xelma-Blockchain)
- **TypeScript Bindings**: [@tevalabs/xelma-bindings](https://www.npmjs.com/package/@tevalabs/xelma-bindings)
- **Frontend**: Coming soon

---

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## License

ISC

---

**Built with â¤ï¸ by the TevaLabs team on Stellar**
