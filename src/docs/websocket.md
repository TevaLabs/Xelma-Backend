# Socket.IO Client Contract Documentation

This document defines the real-time event contract, lifecycle events, and type structures for the Xelma Backend gateway (`src/socket.ts`).

> **Type-safe contracts**: All event names and payloads are defined in
> [`src/types/socket-events.ts`](../types/socket-events.ts). Server emits and
> client listeners share these types, giving you compile-time safety.
> Frontend projects can import `TypedClientSocket` directly from that file.

---

## Connection Lifecycle & Authentication

### 1. Connection Requirements

Connections use the standard Socket.IO client library against the root namespace (`/`). Authentication requires a valid JWT in the initial handshake.

- **Production Gateway URL:** `https://api.tevalabs.com`
- **Protocol:** WebSocket / polling fallback

```typescript
import { io } from "socket.io-client";
// types are co-located with src/, so the relative path from src/docs/ is ../types/socket-events
import type { TypedClientSocket } from "../types/socket-events";

const socket: TypedClientSocket = io("https://api.tevalabs.com", {
  auth: {
    token: "YOUR_JWT_ACCESS_TOKEN",
  },
  autoConnect: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
});

// All events are fully typed — no guessing payload shapes
socket.on("round:started", (data) => {
  console.log(data.id); // string
  console.log(data.startPrice); // typed
});
```

### 2. Heartbeat Contract

On connect the server emits `server:hello` with the heartbeat configuration:

```typescript
interface ServerHelloPayload {
  socketId: string;
  pingInterval: number;   // 25_000 ms
  pingTimeout: number;     // 10_000 ms
  authenticated: boolean;
  userId?: string;
}
```

Clients that do not receive a server ping within `pingInterval + pingTimeout` ms should reconnect.

### 3. Token Expiry & Reconnect

When the JWT expires the server emits `auth:error` then disconnects the socket:

```typescript
interface AuthErrorPayload {
  code: "AUTH_TOKEN_EXPIRED" | "AUTH_TOKEN_INVALID";
  message: string;
}
```

**Client flow:**
1. Listen for `auth:error` events.
2. On `code === "AUTH_TOKEN_EXPIRED"`: call the HTTP token refresh endpoint `POST /api/auth/refresh`:
   ```bash
   curl -X POST "$API_BASE_URL/api/auth/refresh" \
     -H "Authorization: Bearer YOUR_EXPIRED_JWT"
   ```
   Or send the token in the request body `{ "token": "YOUR_EXPIRED_JWT" }`.
3. Reconnect with the new token returned in `response.data.token` set as `socket.handshake.auth.token`.
4. Re-join rooms (e.g. `join:round`, `join:chat`) after reconnect without requiring a full wallet re-authentication challenge.

### 4. Reconnect Continuity

After a reconnect, the server sends a `session:resume` event that lists previously-joined rooms and saved metadata:

```typescript
interface ResumePayload {
  rooms: string[];
  metadata: Record<string, unknown> | null;
}
```

Clients can save per-session state via `session:checkpoint`:

```typescript
socket.emit("session:checkpoint", { lastViewedRound: "abc-123" });
```

---

## Client-to-Server Events

| Event | Payload | Ack | Description |
|-------|---------|-----|-------------|
| `join:round` | `{ roundId?: string }` | — | Join a round room (omit roundId for general round room) |
| `leave:round` | `{ roundId?: string }` | — | Leave a round room |
| `join:chat` | — | — | Join the global chat room (auth required) |
| `leave:chat` | — | — | Leave the chat room |
| `chat:send` | `{ content: string }` | `ChatAckPayload` | Send a chat message (auth required, rate-limited) |
| `join:notifications` | — | — | Join personal notification room (auth required) |
| `session:checkpoint` | `Record<string, unknown>` | — | Save opaque session metadata for reconnect |

### Chat Send Ack

All `chat:send` messages require an ack callback:

```typescript
type ChatAckPayload =
  | { ok: true; message: ChatMessage }
  | { ok: false; error: string; code: "AUTH_REQUIRED" | "INVALID_CONTENT" | "RATE_LIMITED" | "SEND_FAILED" };
```

---

## Server-to-Client Events

### Round Events

**`round:started`** — A new prediction round begins:

```typescript
interface RoundStartedPayload {
  id: string;
  mode: string;
  status: string;
  startTime: unknown;
  endTime: unknown;
  startPrice: unknown;
  priceRanges: unknown;
}
```

**`prediction:placed`** — A user placed a prediction:

```typescript
interface PredictionPlacedPayload {
  roundId: string;
  predictionId: string;
  amount: unknown;
  side: unknown;
  priceRange: unknown;
}
```

**`round:resolved`** — A round has been resolved with final price:

```typescript
interface RoundResolvedPayload {
  id: string;
  status: string;
  startPrice: unknown;
  endPrice: unknown;
  resolvedAt: unknown;
  predictions: number;
  winners: number;
}
```

**`round_update`** — Real-time round state update (pool changes, status changes):

```typescript
interface RoundUpdatePayload {
  id: string;
  mode: string;
  status: string;
  startTime: string | null;
  endTime: string | null;
  startPrice: number | null;
  endPrice: number | null;
  poolUp: number;
  poolDown: number;
  priceRanges: unknown;
  resolvedAt: string | null;
}
```

Broadcast to both the general `round` room and the round-specific `round:{id}` room.

### Price Events

**`price:update`** and **`price_update`** (both carry the same shape):

```typescript
interface PriceUpdatePayload {
  asset: string;      // e.g. "XLM"
  price: number | string;
  timestamp: string;  // ISO 8601
}
```

### Chat Events

**`chat:message`** — New chat message:

```typescript
interface ChatMessage {
  id: string;
  userId: string;
  walletAddress: string;
  content: string;
  createdAt: string;
}
```

### Notification Events

**`notification:new`** — New notification for the user:

```typescript
interface NotificationNewPayload {
  id: string;
  type: string;
  title: string;
  message: string;
  data: unknown;
  isRead: boolean;
  createdAt: string;
}
```

**`notification:unread-count`** — Updated unread count:

```typescript
interface UnreadCountPayload {
  unreadCount: number;
  timestamp: string;
}
```

---

## Typed Client Socket

Import the typed client socket for compile-time safety in frontend projects:

```typescript
import { io } from "socket.io-client";
import type { TypedClientSocket } from "xelma-backend/types/socket-events";

const socket: TypedClientSocket = io("https://api.tevalabs.com", {
  auth: { token: "YOUR_JWT" },
});

socket.on("round:started", (data) => {
  // data is fully typed as RoundStartedPayload
  console.log(data.id, data.mode);
});

socket.emit("join:round", { roundId: "abc-123" });
```

See the full type definitions in [`src/types/socket-events.ts`](../types/socket-events.ts).

Join the `round` room after connect (via your client's room-join handshake) to receive round and bet broadcasts.

---

## Server → Client events

| Event | Room(s) | When |
| --- | --- | --- |
| `round:started` / `round_update` | `round`, `round:{id}` | Round lifecycle |
| `prediction:placed` | `round` | Legacy prediction placement |
| `bet:accepted` | `round`, `round:{id}` (when `roundId` known) | Successful stub or on-chain bet |
| `price:update` / `price_update` | `round`, active `round:{id}` | Oracle price ticks |
| `round:resolved` | `round` | Round resolution |
| `chat:message` | `chat` | Chat |
| `notification:new` | `user:{userId}` | User notification |

### `bet:accepted` (Issue #376)

Emitted **once** after `BetService` successfully records a stub bet or places an on-chain bet. Never emitted when Soroban / validation fails.

```typescript
socket.on("bet:accepted", (payload: {
  roundId?: string;
  address: string;
  amount: number;
  side?: "UP" | "DOWN";      // UP_DOWN only
  mode: "UP_DOWN" | "PRECISION";
  state: string;             // e.g. "stub" | "on-chain-success"
  txHash?: string;           // present for on-chain placements
}) => {
  // Update live pools / activity feed
});
```

Both the hackathon entrypoint (`initWebSocket` in `src/server.ts`) and the full backend (`initializeSocket` in `src/index.ts`) publish through `websocketService`, so clients see the same event regardless of which process is running.
