# Xelma Backend

TypeScript/Node.js backend for the [Xelma](https://github.com/TevaLabs/Xelma-Blockchain) decentralized XLM price prediction market, built on the Stellar blockchain (Soroban).

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Project Structure](#project-structure)
- [Architecture](#architecture)
  - [Core Services](#core-services)
  - [Routes & Endpoints](#routes--endpoints)
  - [Middleware](#middleware)
  - [Database Schema](#database-schema)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Environment Setup](#environment-setup)
- [Running the Server](#running-the-server)
- [API Documentation](#api-documentation)
  - [Authentication Endpoints](#authentication-endpoints)
  - [Round Management](#round-management)
  - [Prediction Endpoints](#prediction-endpoints)
  - [Leaderboard & User Stats](#leaderboard--user-stats)
  - [WebSocket Events](#websocket-events)
- [Testing](#testing)
- [Scripts](#scripts)
- [Troubleshooting](#troubleshooting)
- [Related Repositories](#related-repositories)

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

- ✅ **Wallet-Based Authentication**: Users authenticate with Stellar wallet signatures (no passwords)
- ✅ **Two Game Modes**: UP_DOWN (binary) and LEGENDS (range-based) prediction markets
- ✅ **Real-Time Price Oracle**: Polls CoinGecko every 10 seconds for XLM/USD prices
- ✅ **Soroban Integration**: Creates and resolves rounds on-chain via `@tevalabs/xelma-bindings`
- ✅ **WebSocket Support**: Live updates for prices, rounds, chat, and notifications
- ✅ **Leaderboard System**: Tracks wins, earnings, and streaks across game modes
- ✅ **Automated Schedulers**: Cron jobs for round creation, locking, and resolution
- ✅ **OpenAPI Documentation**: Auto-generated Swagger UI at `/api-docs`
- ✅ **Rate Limiting**: Protects endpoints from abuse
- ✅ **Comprehensive Logging**: Winston-based logging for debugging and monitoring

---

## Project Structure

```
Xelma-Backend/
├── src/
│   ├── index.ts                    # Application entry point
│   ├── socket.ts                   # Socket.IO initialization with JWT auth
│   │
│   ├── routes/                     # Express route handlers
│   │   ├── auth.routes.ts          # Authentication (login, verify)
│   │   ├── user.routes.ts          # User profile management
│   │   ├── rounds.routes.ts        # Round creation & resolution (admin/oracle)
│   │   ├── predictions.routes.ts   # Submit & claim predictions
│   │   ├── leaderboard.routes.ts   # Leaderboard & user stats
│   │   ├── education.routes.ts     # Educational tips
│   │   ├── chat.routes.ts          # Chat message submission
│   │   └── notifications.routes.ts # User notifications
│   │
│   ├── services/                   # Business logic layer
│   │   ├── oracle.ts               # Price fetching from CoinGecko
│   │   ├── soroban.service.ts      # Soroban contract interaction
│   │   ├── round.service.ts        # Round lifecycle management
│   │   ├── prediction.service.ts   # Prediction submission & validation
│   │   ├── resolution.service.ts   # Round resolution & payout calculation
│   │   ├── leaderboard.service.ts  # Leaderboard data aggregation
│   │   ├── websocket.service.ts    # WebSocket event emissions
│   │   ├── notification.service.ts # Notification creation & delivery
│   │   ├── education-tip.service.ts# Educational content management
│   │   ├── chat.service.ts         # Chat message handling
│   │   ├── scheduler.service.ts    # General cron job scheduler
│   │   └── round-scheduler.service.ts # Round creation/locking scheduler
│   │
│   ├── middleware/                 # Express middleware
│   │   ├── auth.middleware.ts      # JWT verification & role checking
│   │   └── rateLimiter.middleware.ts # Rate limiting configuration
│   │
│   ├── utils/                      # Utility functions
│   │   ├── logger.ts               # Winston logger setup
│   │   ├── jwt.util.ts             # JWT generation & verification
│   │   └── challenge.util.ts       # Wallet challenge generation
│   │
│   ├── types/                      # TypeScript type definitions
│   │   ├── auth.types.ts           # Authentication types
│   │   ├── round.types.ts          # Round & game mode types
│   │   ├── leaderboard.types.ts    # Leaderboard types
│   │   ├── education.types.ts      # Education tip types
│   │   ├── chat.types.ts           # Chat message types
│   │   ├── prisma.types.ts         # Prisma client extensions
│   │   └── xelma-bindings.d.ts     # Xelma bindings type stubs
│   │
│   ├── lib/
│   │   └── prisma.ts               # Prisma client instance
│   │
│   ├── docs/
│   │   └── openapi.ts              # OpenAPI/Swagger configuration
│   │
│   ├── scripts/
│   │   ├── generate-openapi.ts     # Generate OpenAPI JSON
│   │   └── export-postman.ts       # Export Postman collection
│   │
│   └── tests/                      # Jest test suites
│       ├── education-tip.service.spec.ts
│       ├── education-tip.route.spec.ts
│       └── round.spec.ts
│
├── prisma/
│   ├── schema.prisma               # Prisma database schema
│   ├── migrations/                 # Database migrations
│   └── seed.ts                     # Database seeding script
│
├── dist/                           # Compiled JavaScript output
├── docs/                           # Additional documentation
├── .env.example                    # Environment variables template
├── package.json                    # Project dependencies & scripts
├── tsconfig.json                   # TypeScript configuration
├── jest.config.ts                  # Jest testing configuration
└── README.md                       # This file
```

---

## Architecture

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
- `GET /:walletAddress/public-profile` - Get any user's public profile

#### **Round Management (`/api/rounds`)**
- `POST /start` - [Admin] Start a new round
- `GET /active` - Get all active rounds
- `GET /:id` - Get specific round details
- `POST /:id/resolve` - [Oracle] Resolve a round with final price

#### **Predictions (`/api/predictions`)**
- `POST /submit` - [Auth] Submit a prediction for a round
- `GET /user/:userId` - Get user's prediction history
- `GET /round/:roundId` - Get all predictions for a round

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
- `GET /api/price` - Current XLM/USD price with staleness info
- `GET /api-docs` - Swagger UI documentation
- `GET /api-docs.json` - OpenAPI specification

---

### Middleware

#### **Authentication Middleware (`auth.middleware.ts`)**
- **`authenticateUser`**: Verifies JWT token and attaches user to request
- **`requireAdmin`**: Ensures user has ADMIN role
- **`requireOracle`**: Ensures user has ORACLE role

#### **Rate Limiter Middleware (`rateLimiter.middleware.ts`)**
- Prevents API abuse by limiting requests per IP
- Configurable limits per endpoint

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

This will automatically:
- Install all dependencies including `@tevalabs/xelma-bindings`
- Run `postinstall` script to build the TypeScript code

---

## Environment Setup

### 1. Copy Environment Template

```bash
cp .env.example .env
```

### 2. Configure Environment Variables

## Environment Variables

This application requires specific environment variables to run securely. Create a `.env` file in the root directory based on `.env.example`.

### Required Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `JWT_SECRET` | Cryptographic secret used to sign and verify JSON Web Tokens. **App will refuse to start without this.** | *None* |

*Note: For production, `JWT_SECRET` must be a cryptographically strong, random string (e.g., generated via `openssl rand -base64 32`).*

Open `.env` and set the following:

```env
# Server Configuration
PORT=3000
NODE_ENV=development
CLIENT_URL=http://localhost:5173

# Database
DATABASE_URL=postgresql://username:password@localhost:5432/xelma_db

# JWT Authentication
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
JWT_EXPIRY=7d

# Xelma Bindings API Key (if required by your setup)
XELMA_API_KEY=your-xelma-api-key-here

# Soroban Configuration
SOROBAN_NETWORK=testnet  # or 'mainnet'
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
SOROBAN_CONTRACT_ID=your-deployed-contract-id

# Stellar Keypairs (use Stellar Laboratory to generate)
# Admin keypair for creating rounds
SOROBAN_ADMIN_SECRET=S...your-admin-secret-key

# Oracle keypair for resolving rounds
SOROBAN_ORACLE_SECRET=S...your-oracle-secret-key

# Round Scheduler
ROUND_SCHEDULER_ENABLED=false  # Set to 'true' to enable automated rounds
ROUND_SCHEDULER_MODE=UP_DOWN   # or 'LEGENDS'
```

### 3. Set Up Database

```bash
# Generate Prisma client
npm run prisma:generate

# Run migrations
npm run prisma:migrate

# (Optional) Seed database with sample data
npx prisma db seed
```

> **Note**: Never commit your `.env` file. It contains sensitive credentials.

---

## Running the Server

### Development Mode (with hot-reload)

```bash
npm run dev
```

The server will start on `http://localhost:3000` with auto-reload on file changes.

### Production Mode

```bash
# Build TypeScript to JavaScript
npm run build

# Start production server
npm start
```

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

## API Documentation

The backend provides auto-generated **OpenAPI/Swagger** documentation.

- **Swagger UI**: [http://localhost:3000/api-docs](http://localhost:3000/api-docs)
- **OpenAPI JSON**: [http://localhost:3000/api-docs.json](http://localhost:3000/api-docs.json)

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
      "totalEarnings": 5432.10,
      "totalPredictions": 60,
      "accuracy": 75.0,
      "modeStats": {
        "upDown": { "wins": 30, "losses": 15, "earnings": 3000.0, "accuracy": 66.67 },
        "legends": { "wins": 15, "losses": 0, "earnings": 2432.10, "accuracy": 100.0 }
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
import io from 'socket.io-client';

const socket = io('http://localhost:3000', {
  auth: {
    token: 'YOUR_JWT_TOKEN'
  }
});

// Listen for price updates
socket.on('price_update', (data) => {
  console.log('New price:', data);
  // { asset: 'XLM', price: 0.1234, timestamp: '...' }
});

// Listen for round updates
socket.on('round_update', (data) => {
  console.log('Round update:', data);
  // { type: 'created'|'locked'|'resolved', round: {...} }
});

// Listen for balance updates
socket.on('user_balance_update', (data) => {
  console.log('Balance update:', data);
  // { userId: '...', balance: 1050 }
});

// Listen for notifications
socket.on('new_notification', (notification) => {
  console.log('Notification:', notification);
});

// Listen for chat messages
socket.on('new_message', (message) => {
  console.log('Chat:', message);
});
```

---

## Testing

Run the test suite with Jest:

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch
```

Current test coverage includes:
- Education tip service tests
- Education tip route tests
- Round service tests

---

## Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Run production server (requires build) |
| `npm run dev` | Start development server with hot-reload |
| `npm run build` | Compile TypeScript to JavaScript |
| `npm test` | Run Jest test suite |
| `npm run test:watch` | Run tests in watch mode |
| `npm run prisma:generate` | Generate Prisma client |
| `npm run prisma:migrate` | Run database migrations |
| `npm run docs:openapi` | Generate OpenAPI JSON spec |
| `npm run docs:postman` | Export Postman collection |

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

## Xelma Backend Improvement Issue Backlog (Draft)

The following are proposed issue drafts you can open in GitHub. They are based on the current backend code and prioritize security, correctness, reliability, and maintainability.

### #1 Consolidate Prisma Client Usage to a Single Shared Instance
Context
Multiple files instantiate `new PrismaClient()` directly (for example middleware/services/socket), while `src/lib/prisma.ts` already provides a shared singleton. This can cause excess DB connections and inconsistent behavior across environments.

What Needs to Happen
- Replace direct `new PrismaClient()` usage with imports from `src/lib/prisma.ts`.
- Ensure all services/middleware/socket paths use the same Prisma lifecycle.
- Add a lightweight check/test to prevent regressions.

Files to Create/Modify
- `src/middleware/auth.middleware.ts`
- `src/services/round.service.ts`
- `src/services/notification.service.ts`
- `src/services/scheduler.service.ts`
- `src/socket.ts`

Acceptance Criteria
- No direct `new PrismaClient()` remains outside `src/lib/prisma.ts`.
- App behavior is unchanged functionally.
- No Prisma connection warnings during local development under load.

How to Validate
- Run `npm run build`.
- Run `npm test`.
- Start app and verify no repeated Prisma client initialization/connection warnings.

PR Requirements
- PR title: `refactor: centralize prisma client usage`
- Include `Closes #[issue_id]` in PR description

### #2 Refactor App Bootstrap for Testability and Graceful Shutdown
Context
`src/index.ts` starts polling, schedulers, WebSocket emission interval, and HTTP listen as import-time side effects. This makes integration testing harder and complicates graceful shutdown.

What Needs to Happen
- Introduce explicit `createApp()` and `startServer()` lifecycle functions.
- Track interval/cron handles and close them on shutdown signals.
- Add shutdown hooks for HTTP server and Prisma disconnect.

Files to Create/Modify
- `src/index.ts`
- `src/services/oracle.ts`
- `src/services/scheduler.service.ts`
- `src/services/round-scheduler.service.ts`
- `src/lib/prisma.ts`

Acceptance Criteria
- Importing app module does not automatically bind network ports.
- Server exits cleanly on `SIGINT`/`SIGTERM`.
- Test suites can initialize app without background jobs running unexpectedly.

How to Validate
- Run `npm test`.
- Start app and stop with Ctrl+C; ensure clean shutdown logs with no hanging process.

PR Requirements
- PR title: `refactor: isolate startup side effects and add graceful shutdown`
- Include `Closes #[issue_id]` in PR description

### #3 Fix Round Mode Validation Bug in Start Round Endpoint
Context
`POST /api/rounds/start` validates mode with `if (!mode || mode < 0 || mode > 1)` which incorrectly rejects valid mode `0` (`UP_DOWN`).

What Needs to Happen
- Replace falsy checks with explicit numeric validation.
- Add validation tests for `mode=0` and `mode=1`.

Files to Create/Modify
- `src/routes/rounds.routes.ts`
- `src/tests/round.spec.ts`

Test Scenarios
- `mode=0` accepted.
- `mode=1` accepted.
- invalid values (`-1`, `2`, string) rejected with `400`.

Acceptance Criteria
- `UP_DOWN` rounds can be created via API.
- Validation behavior is deterministic and covered by tests.

How to Validate
- Run `npm test -- --testPathPattern=round`.

PR Requirements
- PR title: `fix: correct mode validation for round creation`
- Include `Closes #[issue_id]` in PR description

### #4 Enforce Authenticated User Identity in Predictions Endpoint
Context
`POST /api/predictions/submit` currently accepts `userId` from request body despite requiring JWT auth. This allows user impersonation by submitting predictions for another user.

What Needs to Happen
- Remove `userId` from request body contract.
- Use `req.user.userId` as the single source of identity.
- Update OpenAPI docs and tests.

Files to Create/Modify
- `src/routes/predictions.routes.ts`
- `src/docs/openapi.ts`
- `src/tests/` (add predictions route tests)

Acceptance Criteria
- Endpoint ignores/rejects external `userId` input.
- Authenticated user can only submit for self.
- Docs reflect updated request schema.

How to Validate
- Add test with mismatched body `userId`; assert request fails or body field is ignored.
- Run `npm test`.

PR Requirements
- PR title: `security: bind prediction submissions to authenticated user`
- Include `Closes #[issue_id]` in PR description

### #5 Make Prediction Submission Atomic with Database Transactions
Context
Prediction placement performs multiple writes (prediction insert, balance update, pool update, Soroban call) without transactional boundaries, risking partial state on failure or concurrency races.

What Needs to Happen
- Use Prisma transactions for DB writes.
- Define contract for external Soroban call ordering and rollback strategy.
- Add concurrency-aware tests for duplicate submissions and balance integrity.

Files to Create/Modify
- `src/services/prediction.service.ts`
- `src/tests/` (new prediction service tests)

Acceptance Criteria
- No partial DB updates when any step fails.
- User balance and round pools remain consistent under concurrent submissions.

How to Validate
- Run test suite including failure-injection scenarios.
- Run stress test script for concurrent submissions.

PR Requirements
- PR title: `fix: make prediction placement transactional and race-safe`
- Include `Closes #[issue_id]` in PR description

### #6 Prevent Multiple Active Rounds from Being Created Concurrently
Context
Round creation paths (manual and scheduler) do not guard against overlapping active rounds. This can create ambiguous active state and inconsistent client behavior.

What Needs to Happen
- Enforce active-round guard by mode (or globally, per product rule).
- Add conflict response (for example `409`) from API layer.
- Ensure scheduler respects existing active rounds.

Files to Create/Modify
- `src/services/round.service.ts`
- `src/services/round-scheduler.service.ts`
- `src/routes/rounds.routes.ts`
- `src/tests/round.spec.ts`

Acceptance Criteria
- At most one active round per defined constraint.
- Scheduler does not create overlapping active rounds.

How to Validate
- Start round, attempt second creation immediately, assert conflict.
- Run scheduler simulation with existing active round.

PR Requirements
- PR title: `fix: enforce single active round constraint`
- Include `Closes #[issue_id]` in PR description

### #7 Add Idempotent State Transition Guards for Lock and Resolve Flows
Context
Lock/resolve operations run in loops and cron contexts. Without strict state transition guards and idempotency, repeated jobs can cause noisy failures and inconsistent side effects.

What Needs to Happen
- Make `lockRound` and `resolveRound` state transitions conditional and idempotent.
- Return explicit outcomes (`updated`, `already_locked`, `already_resolved`).
- Add retry-safe scheduler behavior.

Files to Create/Modify
- `src/services/round.service.ts`
- `src/services/resolution.service.ts`
- `src/services/scheduler.service.ts`
- `src/services/round-scheduler.service.ts`

Acceptance Criteria
- Re-running lock/resolve for same round is safe.
- Schedulers do not emit false errors on already-processed rounds.

How to Validate
- Trigger same operation twice and verify second pass is no-op.
- Run auto-resolve job repeatedly with same dataset.

PR Requirements
- PR title: `fix: make round lifecycle transitions idempotent`
- Include `Closes #[issue_id]` in PR description

### #8 Add `resolvedAt` Timestamp Support and Response Consistency
Context
Round resolve responses reference `resolvedAt`, but schema currently has no such field, producing undefined data and inconsistent API contracts.

What Needs to Happen
- Add `resolvedAt` to Prisma `Round` model via migration.
- Populate it during resolution.
- Ensure API docs and response payloads are aligned.

Files to Create/Modify
- `prisma/schema.prisma`
- `prisma/migrations/` (new migration)
- `src/services/resolution.service.ts`
- `src/routes/rounds.routes.ts`

Acceptance Criteria
- Resolved rounds always include non-null `resolvedAt`.
- API response schema matches runtime output.

How to Validate
- Run `npm run prisma:migrate`.
- Resolve a round and verify `resolvedAt` persisted and returned.

PR Requirements
- PR title: `feat: persist resolvedAt for rounds`
- Include `Closes #[issue_id]` in PR description

### #9 Make Challenge Verification and Consumption Atomic
Context
Auth challenge lookup and `isUsed` update occur in separate operations, leaving a race window where the same challenge could be consumed by concurrent requests.

What Needs to Happen
- Use transaction or conditional update (`updateMany` with `isUsed=false`) to consume challenge atomically.
- Ensure only one request can successfully consume each challenge.
- Add concurrent auth tests.

Files to Create/Modify
- `src/routes/auth.routes.ts`
- `src/tests/` (new auth route race tests)

Acceptance Criteria
- Challenge replay via concurrent requests is prevented.
- Exactly one request succeeds for a single challenge.

How to Validate
- Run parallel connect requests with same challenge and signature.
- Assert one success, one auth failure.

PR Requirements
- PR title: `security: atomically consume auth challenges`
- Include `Closes #[issue_id]` in PR description

### #10 Enforce Required JWT Secret and Strong Startup Validation
Context
JWT utility falls back to a weak default secret when env var is missing, creating a critical production risk.

What Needs to Happen
- Remove insecure default JWT secret fallback.
- Add startup config validation for required env vars.
- Fail fast with clear error messages.

Files to Create/Modify
- `src/utils/jwt.util.ts`
- `src/index.ts`
- `README.md` (env requirements)

Acceptance Criteria
- App refuses startup without `JWT_SECRET`.
- No hardcoded fallback secret remains.

How to Validate
- Start app without `JWT_SECRET`; verify startup fails clearly.
- Start with valid secret; verify normal auth flows.

PR Requirements
- PR title: `security: require explicit jwt secret configuration`
- Include `Closes #[issue_id]` in PR description

### #11 Replace `console.*` Logging with Structured Logger Everywhere
Context
Codebase mixes `console.log/error/warn` with Winston logger, reducing observability consistency and log parsing quality.

What Needs to Happen
- Replace console statements with `logger` utility.
- Standardize log fields and context objects.
- Ensure production-friendly log formatting.

Files to Create/Modify
- `src/services/oracle.ts`
- `src/routes/auth.routes.ts`
- `src/routes/user.routes.ts`
- `src/routes/education.routes.ts`
- `src/services/*` (as needed)

Acceptance Criteria
- No direct `console.*` usage in runtime paths.
- Logs are structured and consistent across modules.

How to Validate
- Grep for `console.` and confirm runtime files are clean.
- Run app and verify consistent logger output.

PR Requirements
- PR title: `chore: standardize structured logging across backend`
- Include `Closes #[issue_id]` in PR description

### #12 Add Lifecycle Control for Oracle Polling and Price Broadcast Interval
Context
Oracle polling and price emit intervals are started without stop handles. In tests/restarts this can create duplicate timers and noisy behavior.

What Needs to Happen
- Return and manage interval handles for polling and broadcast loops.
- Add `start/stop` semantics to prevent duplicate starts.
- Use lifecycle hooks from app bootstrap.

Files to Create/Modify
- `src/services/oracle.ts`
- `src/index.ts`
- `src/tests/` (new timer lifecycle tests)

Acceptance Criteria
- Polling and emit loops can be started once and stopped cleanly.
- No duplicate interval activity after restart in process.

How to Validate
- Run lifecycle tests with fake timers.
- Manual restart scenario confirms single active loop.

PR Requirements
- PR title: `fix: add start-stop lifecycle for oracle and price broadcast`
- Include `Closes #[issue_id]` in PR description

### #13 Expand Rate Limiting to Critical Write Endpoints
Context
Rate limiting is strong on auth/chat but missing on several write-heavy endpoints such as prediction submission and round operations, increasing abuse/DoS risk.

What Needs to Happen
- Add per-user and per-IP rate limits for high-risk mutation routes.
- Add separate stricter policies for admin/oracle actions.
- Document limits in OpenAPI.

Files to Create/Modify
- `src/middleware/rateLimiter.middleware.ts`
- `src/routes/predictions.routes.ts`
- `src/routes/rounds.routes.ts`
- `src/docs/openapi.ts`

Acceptance Criteria
- Abuse-prone endpoints are rate-limited with tailored policies.
- OpenAPI docs reflect 429 behavior for affected routes.

How to Validate
- Hit endpoints in burst and verify `429` responses.
- Confirm normal usage remains unaffected.

PR Requirements
- PR title: `security: add rate limits for mutation endpoints`
- Include `Closes #[issue_id]` in PR description

### #14 Harden Oracle Integration with Timeouts, Retries, and Staleness Checks
Context
Price oracle currently fetches from one source with minimal resilience. Failures keep stale values silently and there is no explicit freshness metadata on served price.

What Needs to Happen
- Add request timeout and retry/backoff.
- Track `lastUpdatedAt` and expose staleness in API.
- Define behavior when data is stale (for example block round creation/resolution).

Files to Create/Modify
- `src/services/oracle.ts`
- `src/index.ts` (price endpoint)
- `src/services/round-scheduler.service.ts`
- `src/services/scheduler.service.ts`

Acceptance Criteria
- Oracle fetch behavior is resilient to transient failures.
- API exposes freshness metadata.
- Scheduler decisions include staleness safeguards.

How to Validate
- Simulate API failures/timeouts and verify retries + stale handling.
- Confirm round creation/resolution behavior follows policy.

PR Requirements
- PR title: `feat: add resilient oracle fetching and freshness safeguards`
- Include `Closes #[issue_id]` in PR description

### #15 Integrate Real Soroban Bindings and Remove Placeholder Client
Context
`src/services/soroban.service.ts` currently defines `Client` as `undefined as any`, while runtime methods depend on it. This can break critical blockchain flows silently at runtime.

What Needs to Happen
- Properly import and initialize client from `@tevalabs/xelma-bindings`.
- Add typed request/response handling and robust error mapping.
- Add integration tests/mocks for create/place/resolve flows.

Files to Create/Modify
- `src/services/soroban.service.ts`
- `src/types/xelma-bindings.d.ts` (if still needed)
- `src/tests/` (new soroban service tests)

Acceptance Criteria
- Soroban client initialization is fully functional and typed.
- No placeholder `undefined as any` client code remains.
- Core blockchain calls are covered by tests.

How to Validate
- Run targeted Soroban service tests.
- Perform manual test flow: create round, place bet, resolve.

PR Requirements
- PR title: `fix: wire real soroban bindings client with typed integration`
- Include `Closes #[issue_id]` in PR description

### #16 Synchronize README and OpenAPI with Actual Implemented Endpoints
Context
Current README route tables include outdated paths and endpoint names that do not match implemented routes (for example auth, chat, education, rounds).

What Needs to Happen
- Reconcile README endpoint sections with route files.
- Ensure OpenAPI examples and operation summaries match real behavior.
- Add a lightweight docs verification checklist.

Files to Create/Modify
- `README.md`
- `src/docs/openapi.ts`
- `docs/openapi.json` (regenerated)
- `docs/postman-collection.json` (regenerated)

Acceptance Criteria
- No stale endpoint names or paths in docs.
- Generated docs reflect current API contract.

How to Validate
- Run `npm run docs:openapi` and `npm run docs:postman`.
- Spot-check a sample of endpoints from docs against running server.

PR Requirements
- PR title: `docs: align readme and openapi with implemented routes`
- Include `Closes #[issue_id]` in PR description

### #17 Introduce Request Schema Validation Layer for All Routes
Context
Input validation is currently ad hoc and duplicated in routes, increasing inconsistency and missed edge cases.

What Needs to Happen
- Add a shared validation layer (for example Zod/Joi).
- Define schemas for auth, rounds, predictions, chat, and pagination query params.
- Standardize validation error shape.

Files to Create/Modify
- `src/middleware/` (new validation middleware)
- `src/routes/auth.routes.ts`
- `src/routes/rounds.routes.ts`
- `src/routes/predictions.routes.ts`
- `src/routes/chat.routes.ts`

Acceptance Criteria
- Major routes use centralized schema validation.
- Validation errors are consistent and documented.

How to Validate
- Add route tests for invalid payloads/types.
- Run `npm test`.

PR Requirements
- PR title: `refactor: add centralized request schema validation`
- Include `Closes #[issue_id]` in PR description

### #18 Add Coverage for Auth, Prediction, Notification, and Socket Flows
Context
Current tests focus mainly on education and round service. Core auth, prediction, notification, and WebSocket paths lack meaningful automated coverage.

What Needs to Happen
- Add unit and route tests for auth challenge/connect and JWT guards.
- Add prediction route/service tests for success and failures.
- Add notification route/service tests including ownership checks.
- Add Socket.IO auth and room event tests.

Files to Create/Modify
- `src/tests/auth.routes.spec.ts` (new)
- `src/tests/prediction.service.spec.ts` (new)
- `src/tests/notifications.routes.spec.ts` (new)
- `src/tests/socket.spec.ts` (new)

Acceptance Criteria
- Core user-critical flows are covered by automated tests.
- Regression risk for auth/prediction/socket paths is reduced.

How to Validate
- Run `npm test`.
- Confirm new suites pass consistently in CI/local.

PR Requirements
- PR title: `test: expand coverage for auth prediction notifications and sockets`
- Include `Closes #[issue_id]` in PR description

### #19 Add Scheduler Integration Tests with Fake Timers and DB Fixtures
Context
Cron-driven behavior is difficult to reason about and currently under-tested. Round locking/resolution logic should be verified in time-driven scenarios.

What Needs to Happen
- Add scheduler tests using fake timers.
- Cover auto-lock and auto-resolve decision logic.
- Verify no duplicate processing and proper status transitions.

Files to Create/Modify
- `src/tests/scheduler.service.spec.ts` (new)
- `src/tests/round-scheduler.service.spec.ts` (new)
- `src/services/scheduler.service.ts` (small testability hooks)
- `src/services/round-scheduler.service.ts` (small testability hooks)

Acceptance Criteria
- Scheduler behavior is deterministic under test.
- Time-based lifecycle transitions are covered.

How to Validate
- Run targeted scheduler tests and full `npm test`.

PR Requirements
- PR title: `test: add deterministic coverage for cron schedulers`
- Include `Closes #[issue_id]` in PR description

### #20 Migrate Monetary Fields from Float to Decimal-Safe Representation
Context
Balances, pools, and payouts currently rely on `Float` values in Prisma/models, which can introduce rounding drift in financial calculations.

What Needs to Happen
- Migrate monetary fields to `Decimal` (or integer minor units) in Prisma schema.
- Update service calculations and serialization.
- Add tests to verify deterministic payout math.

Files to Create/Modify
- `prisma/schema.prisma`
- `prisma/migrations/` (new migration)
- `src/services/prediction.service.ts`
- `src/services/resolution.service.ts`
- `src/services/leaderboard.service.ts`
- `src/tests/` (new monetary precision tests)

Acceptance Criteria
- No float precision anomalies in balance/payout flows.
- Monetary calculations are deterministic across environments.

How to Validate
- Run migration and targeted payout tests with fractional edge cases.
- Verify balances reconcile after multi-round simulation.

PR Requirements
- PR title: `refactor: move monetary math to decimal-safe types`
- Include `Closes #[issue_id]` in PR description

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

**Built with ❤️ by the TevaLabs team on Stellar**
