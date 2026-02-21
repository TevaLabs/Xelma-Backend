# Xelma Backend

TypeScript/Node.js backend for the [Xelma](https://github.com/TevaLabs/Xelma-Blockchain) decentralized XLM price prediction market, built on the Stellar blockchain (Soroban).

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Environment Setup](#environment-setup)
- [Using @tevalabs/xelma-bindings](#using-tevalabsxelma-bindings)
  - [Backend (Node.js)](#backend-nodejs)
  - [Frontend (React / Next.js)](#frontend-react--nextjs)
- [Running the Server](#running-the-server)
- [API Authentication](#api-authentication)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- Node.js 18+
- npm, pnpm, or yarn
- PostgreSQL database
- A Stellar testnet or mainnet account (for admin/oracle keys)

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/TevaLabs/Xelma-Backend.git
cd Xelma-Backend
```

### 2. Install dependencies

```bash
npm install
# or
pnpm install
# or
yarn install
```

### 3. Install @tevalabs/xelma-bindings

The Xelma TypeScript bindings are a separate package that provides typed access to the Soroban smart contract. Install it in the backend (and frontend) with your package manager of choice:

```bash
npm install @tevalabs/xelma-bindings
# or
pnpm add @tevalabs/xelma-bindings
# or
yarn add @tevalabs/xelma-bindings
```

---

## Environment Setup

Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

Open `.env` and set each variable:

```env
# Server
PORT=3000
NODE_ENV=development
CLIENT_URL=http://localhost:5173

# Database
DATABASE_URL=postgresql://username:password@localhost:5432/xelma_db

# JWT
JWT_SECRET=your-super-secret-jwt-key
JWT_EXPIRY=7d

# Xelma Bindings – API Key
# Required to authenticate requests made with @tevalabs/xelma-bindings
XELMA_API_KEY=your-xelma-api-key-here

# Soroban Network (mainnet | testnet)
SOROBAN_NETWORK=testnet

# Soroban RPC endpoint
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org

# Deployed contract ID (from Xelma-Blockchain repo)
SOROBAN_CONTRACT_ID=your-contract-id-here

# Stellar secret key for the admin account
SOROBAN_ADMIN_SECRET=S...your-admin-secret-key-here

# Stellar secret key for the oracle account
SOROBAN_ORACLE_SECRET=S...your-oracle-secret-key-here
```

> **Note:** Never commit your `.env` file. It is already listed in `.gitignore`.

---

## Using @tevalabs/xelma-bindings

### Backend (Node.js)

Import the `Client` class and authenticate using your `XELMA_API_KEY` together with the contract configuration read from environment variables:

```typescript
import { Client, BetSide } from '@tevalabs/xelma-bindings';
import { Networks } from '@stellar/stellar-sdk';

const client = new Client({
  contractId: process.env.SOROBAN_CONTRACT_ID!,
  networkPassphrase:
    process.env.SOROBAN_NETWORK === 'mainnet'
      ? Networks.PUBLIC
      : Networks.TESTNET,
  rpcUrl: process.env.SOROBAN_RPC_URL!,
});

// Mint initial tokens for a user
await client.mint_initial({ user: userAddress });

// Read user balance
const balance = await client.balance({ user: userAddress });

// Place a bet
await client.place_bet({
  user: userAddress,
  amount: 100_0000000n, // 100 vXLM in stroops
  side: BetSide.Up,
});

// Get the active round
const round = await client.get_active_round();

// Claim winnings
const claimed = await client.claim_winnings({ user: userAddress });
```

The above snippet is already wired inside [`src/services/soroban.service.ts`](src/services/soroban.service.ts). The service reads all required values from environment variables at startup and disables Soroban integration gracefully if any required variable is missing.

### Frontend (React / Next.js)

Install the package in your frontend project:

```bash
npm install @tevalabs/xelma-bindings
# or
pnpm add @tevalabs/xelma-bindings
# or
yarn add @tevalabs/xelma-bindings
```

Then import and use the client:

```typescript
import { Client, BetSide } from '@tevalabs/xelma-bindings';
import { Networks } from '@stellar/stellar-sdk';

const client = new Client({
  contractId: import.meta.env.VITE_SOROBAN_CONTRACT_ID,
  networkPassphrase: Networks.TESTNET,
  rpcUrl: 'https://soroban-testnet.stellar.org',
});
```

> **Where to import:**
> - **Backend** – import in services that interact with the smart contract (e.g., `src/services/soroban.service.ts`).
> - **Frontend** – import in the hook or service layer that handles blockchain calls (e.g., `src/hooks/useSoroban.ts` or `src/services/contract.ts`).

---

## Running the Server

```bash
# Development (with hot-reload)
npm run dev

# Production build
npm run build
npm start
```

---

## API Authentication

All protected routes require a valid **JWT token** in the `Authorization` header:

```
Authorization: Bearer <token>
```

Role-based access is enforced at the middleware level:

| Role   | Can do                                  |
|--------|-----------------------------------------|
| User   | Place bets, claim winnings, read rounds |
| Admin  | Create rounds                           |
| Oracle | Resolve rounds                          |

If you receive a **401 Unauthorized** response, your JWT is missing or expired — log in again to get a fresh token.

If you receive a **403 Forbidden** response, your account does not have the required role for that endpoint. Check that:
1. Your JWT belongs to an account with the correct role (`admin` or `oracle`).
2. The `SOROBAN_ADMIN_SECRET` / `SOROBAN_ORACLE_SECRET` in your `.env` match the addresses registered in the deployed contract.
3. You are calling the right endpoint for your role (see the [OpenAPI docs](docs/openapi.json) for a full list).

---

## Troubleshooting

### Soroban service is disabled on startup

```
Soroban configuration or bindings missing. Soroban integration DISABLED.
```

This means one or more required environment variables are missing. Verify your `.env` contains:
- `SOROBAN_CONTRACT_ID`
- `SOROBAN_ADMIN_SECRET`
- `SOROBAN_ORACLE_SECRET`

### Cannot find module '@tevalabs/xelma-bindings'

Run `npm install` (or your package manager equivalent) again. If the error persists, check that the package name in `package.json` matches exactly: `@tevalabs/xelma-bindings`.

### RPC connection errors

Ensure `SOROBAN_RPC_URL` points to a live Soroban RPC endpoint. For testnet use:

```
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
```

For a production-grade setup, consider using a dedicated RPC provider (e.g., [Ankr](https://www.ankr.com/), [QuickNode](https://www.quicknode.com/)) and store the provider API key in `XELMA_API_KEY`.

---

## Related Repositories

- **Smart Contract**: [TevaLabs/Xelma-Blockchain](https://github.com/TevaLabs/Xelma-Blockchain)
- **Bindings**: [@tevalabs/xelma-bindings](https://www.npmjs.com/package/@tevalabs/xelma-bindings)
- **Frontend**: Coming soon
