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
- `POST /login` - Initiate wallet-based login (returns challenge)
- `POST /verify` - Verify signed challenge and issue JWT token

#### **User Management (`/api/user`)**
- `GET /profile/:walletAddress` - Get user profile
- `PUT /profile/:userId` - Update user profile (nickname, avatar, preferences)

#### **Round Management (`/api/rounds`)**
- `POST /start` - [Admin] Start a new round
- `GET /active` - Get all active rounds
- `GET /locked` - Get locked (no bets) rounds
- `GET /upcoming` - Get upcoming rounds
- `GET /:roundId` - Get specific round details
- `POST /lock/:roundId` - [Admin] Lock a round manually
- `POST /resolve/:roundId` - [Oracle] Resolve a round

#### **Predictions (`/api/predictions`)**
- `POST /submit` - Submit a prediction for a round
- `GET /user/:userId` - Get user's prediction history
- `GET /round/:roundId` - Get all predictions for a round
- `POST /claim/:predictionId` - Claim winnings for a prediction

#### **Leaderboard (`/api/leaderboard`)**
- `GET /` - Get global leaderboard (paginated)
- `GET /user/:userId` - Get user's leaderboard stats
- `GET /top/:count` - Get top N users

#### **Education (`/api/education`)**
- `GET /tips` - Get all education tips
- `GET /tip/random` - Get random tip
- `GET /tip/daily` - Get daily tip

#### **Chat (`/api/chat`)**
- `POST /message` - Send a chat message
- `GET /messages` - Get recent chat messages (paginated)

#### **Notifications (`/api/notifications`)**
- `GET /user/:userId` - Get user notifications
- `PUT /read/:notificationId` - Mark notification as read
- `DELETE /:notificationId` - Delete a notification

#### **System Endpoints**
- `GET /` - Health check with timestamp
- `GET /health` - Detailed health check (uptime, status)
- `GET /api/price` - Current XLM/USD price
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

#### Login (Request Challenge)

```bash
POST /api/auth/login
Content-Type: application/json

{
  "walletAddress": "GXXX...YOUR_STELLAR_ADDRESS"
}
```

**Response:**
```json
{
  "challenge": "Sign this message to authenticate: abc123xyz"
}
```

#### Verify Signature

```bash
POST /api/auth/verify
Content-Type: application/json

{
  "walletAddress": "GXXX...YOUR_STELLAR_ADDRESS",
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
    "virtualBalance": 1000,
    "role": "USER"
  }
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
  "userId": "user-uuid",
  "amount": 10,
  "side": "UP"  # or "DOWN"
}

# For LEGENDS mode:
{
  "roundId": "round-uuid",
  "userId": "user-uuid",
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
    "userId": "user-uuid",
    "amount": 10,
    "side": "UP",
    "createdAt": "2026-02-23T12:01:00Z"
  },
  "userBalance": 990
}
```

---

### Leaderboard & User Stats

#### Get Global Leaderboard

```bash
GET /api/leaderboard?page=1&limit=10
```

**Response:**
```json
{
  "leaderboard": [
    {
      "rank": 1,
      "walletAddress": "GXXX...",
      "nickname": "CryptoKing",
      "totalEarnings": 5432.10,
      "wins": 45,
      "totalPredictions": 60,
      "accuracy": 75.0
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 150
  }
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
