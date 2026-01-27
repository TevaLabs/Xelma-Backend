# User Management & Daily Bonus Implementation Guide

## Overview

This document explains the changes made to implement User Profile Management, Balance tracking, and the Daily Login Bonus system.

## 1. Database Schema Changes (`prisma/schema.prisma`)

### User Model

We enriched the `User` model to support profile features:

- **`nickname`**: Optional display name.
- **`avatarUrl`**: Optional URL to profile image.
- **`preferences`**: JSON field for storing user settings (e.g., `{ "theme": "dark" }`).
- **`streak`**: Tracks consecutive days logged in.
- **Relation to `Transaction`**: Links a user to their balance history.

### Transaction Model [NEW]

A new model to track every balance change (bonus, win, loss, withdrawal).

- **`type`**: Enum (`BONUS`, `WIN`, `LOSS`, etc.).
- **`amount`**: The magnitude of the change.
- **`description`**: Human-readable reason (e.g., "Daily Login Bonus (Day 3)").

### Cleanup

- Removed duplicate definitions of `Round` and `Prediction` models that were cluttering the schema.

## 2. API Endpoints (`src/routes/user.routes.ts`)

We created a new route file to handle user-related operations.

| Method  | Endpoint                            | Description                                                     |
| ------- | ----------------------------------- | --------------------------------------------------------------- |
| `GET`   | `/api/user/profile`                 | Returns full profile including streak, balance, and last login. |
| `GET`   | `/api/user/balance`                 | Lightweight endpoint for just the balance.                      |
| `GET`   | `/api/user/stats`                   | Returns game statistics (wins/losses).                          |
| `GET`   | `/api/user/transactions`            | Paginated list of balance history.                              |
| `PATCH` | `/api/user/profile`                 | Allows updating nickname, avatar, and preferences.              |
| `GET`   | `/api/user/:address/public-profile` | Publicly accessible profile data.                               |

## 3. Daily Login Bonus Logic (`src/routes/auth.routes.ts`)

The daily bonus is calculated automatically when a user authenticates (`POST /api/auth/connect`).

### Logic Flow:

1.  **Check Last Login**: We compare `lastLoginAt` with current time.
2.  **Determine Day Difference**:
    - **Same Day**: No action (streak/bonus unchanged).
    - **Next Day (Difference = 1)**: Increment `streak`.
    - **Missed Day (Difference > 1)**: Reset `streak` to 1.
3.  **Calculate Bonus**:
    - Base: **100 XLM**.
    - **Streak 3+**: 1.5x Multiplier (150 XLM).
    - **Streak 7+**: 2.0x Multiplier (200 XLM).
4.  **Award**:
    - Update `streak` and `virtualBalance`.
    - Create a `Transaction` record of type `BONUS`.

## 4. How to Test

### Manual Testing with cURL / Postman

**1. Login & Check Bonus**
Log in with a wallet. The response will now include `bonus` (amount awarded) and `streak`.

```json
{
  "token": "...",
  "user": { ... },
  "bonus": 100,
  "streak": 1
}
```

**2. View Profile**
`GET /api/user/profile` with `Authorization: Bearer <token>` header.

**3. Check History**
`GET /api/user/transactions` will show the "Welcome Bonus" or "Daily Login Bonus".

## 5. Next Steps

- Run `npx prisma migrate dev` to apply these schema changes to your local database.
- TypeScript types will update automatically after `prisma generate` (included in migrate).
