# Socket.IO Client Contract Documentation

This document defines the real-time event contract, lifecycle events, and type structures for the Xelma Backend gateway (`src/socket.ts`).

> **Type-safe contracts**: All event names and payloads are defined in
> [`src/types/socket-events.ts`](../types/socket-events.ts). Server emits and
> client listeners share these types, giving you compile-time safety.
> Frontend projects can import `TypedClientSocket` directly from that file.

---

## Connection Lifecycle & Authentication

### 1. Connection Requirements

Connections use the standard Socket.IO client library against the root namespace (`/`). A JWT is **optional for public events** (e.g. `price:update`, `round:*`) but **required** for chat, notifications, and any `user:*` room. The server accepts the token from **either** of these locations (see [`src/socket.ts`](../socket.ts) → `io.use`):

1. `socket.handshake.auth.token` — the preferred/recommended form
2. `Authorization: Bearer <jwt>` header — a fallback for non-browser clients

- **Production Gateway URL:** `https://api.tevalabs.com`
- **Protocol:** WebSocket with polling fallback
- **Auth:** JWT access token, no wallet challenge needed once you already have a token

```typescript
import { io } from "socket.io-client";
// types are co-located with src/, so the relative path from src/docs/ is ../types/socket-events
import type { TypedClientSocket } from "../types/socket-events";

const GATEWAY_URL = "https://api.tevalabs.com";

// Recommended: token in `auth`. The server also accepts an
// `Authorization: Bearer <jwt>` header (see above) for parity with HTTP.
const socket: TypedClientSocket = io(GATEWAY_URL, {
  auth: { token: "YOUR_JWT_ACCESS_TOKEN" },
  autoConnect: true,
  transports: ["websocket", "polling"],
});

// All events are fully typed — no guessing payload shapes
socket.on("round:started", (data) => {
  console.log(data.id); // string
  console.log(data.startPrice); // typed
});
```

> **Connecting without a token is allowed** and yields a public socket (price/round events only). The server emits `server:hello` with `authenticated: false`; joining chat or notification rooms will then fail with `error: { message: "Authentication required..." }`.

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

### 3. Reconnect & Backoff Policy

After a transport drop, re-create the socket and **re-join every room you need** — the reconnect contract treats a new socket as a fresh connection (the server does persist rooms for authenticated users via `session:resume`, but the client should not rely on it as the only path).

Recommended Socket.IO options:

| Option | Recommended value | Why |
|--------|-------------------|-----|
| `reconnection` | `true` | Let Socket.IO manage the retry loop |
| `reconnectionAttempts` | `10` | Give up after ~10 tries, then fall back to a manual retry with a fresh token |
| `reconnectionDelay` | `1000` (ms) | First retry after 1 s |
| `reconnectionDelayMax` | `15000` (ms) | Cap the exponential backoff at 15 s |
| `randomizationFactor` | `0.5` | Jitter to avoid a reconnect thundering herd |

```typescript
import { io } from "socket.io-client";
import type { TypedClientSocket } from "../types/socket-events";

const socket: TypedClientSocket = io("https://api.tevalabs.com", {
  auth: { token: getAccessToken() },
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1_000,
  reconnectionDelayMax: 15_000,
  randomizationFactor: 0.5,
});

// Mirror the client-side backoff for a GET /api/notifications catch-up after
// a reconnect so you don't miss events that fired while offline.
socket.on("connect", () => {
  socket.emit("join:round");
  if (isAuthenticated()) {
    socket.emit("join:chat");
    socket.emit("join:notifications");
  }
});

// Surface reconnect failures so the UI can show a manual "Retry" affordance.
socket.on("reconnect_failed", () => {
  console.warn("Socket reconnection attempts exhausted");
});
```

**Which events need an ack?** Only `chat:send` uses an acknowledgement callback (see the table below). Every other client→server event is fire-and-forget; treat the `room:joined` / `room:left` confirmation events as the acknowledgement for room joins.

### 4. Token Expiry & Reconnect

When the JWT expires the server emits `auth:error` then disconnects the socket:

```typescript
interface AuthErrorPayload {
  code: "AUTH_TOKEN_EXPIRED" | "AUTH_TOKEN_INVALID";
  message: string;
}
```

**Client flow:**
1. Listen for `auth:error` events. During the initial handshake a bad token instead surfaces as a `connect_error` with message `AUTH_TOKEN_EXPIRED` / `AUTH_TOKEN_INVALID` (the server rejects the handshake in `io.use`), so handle both.
2. On `code === "AUTH_TOKEN_EXPIRED"` (or the matching `connect_error`): call the HTTP token refresh endpoint `POST /api/auth/refresh`:
   ```bash
   curl -X POST "$API_BASE_URL/api/auth/refresh" \
     -H "Authorization: Bearer YOUR_EXPIRED_JWT"
   ```
   Or send the token in the request body `{ "token": "YOUR_EXPIRED_JWT" }`.
3. Reconnect with the new token returned in `response.data.token` set as `socket.handshake.auth.token`.
4. Re-join rooms (e.g. `join:round`, `join:chat`) after reconnect without requiring a full wallet re-authentication challenge.

### 5. Reconnect Continuity

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

Server sends `room:joined` / `room:left` after each join/leave; those are the acknowledgements for room membership.

| Event | Payload | Ack | Description |
|-------|---------|-----|-------------|
| `join:round` | `{ roundId?: string }` | `room:joined` | Join a round room (omit roundId for general round room). Also accepts a bare `string` roundId. |
| `leave:round` | `{ roundId?: string }` | `room:left` | Leave a round room |
| `join:chat` | — | `room:joined` | Join the global chat room (auth required) |
| `leave:chat` | — | `room:left` | Leave the chat room |
| `chat:send` | `{ content: string }` | `ChatAckPayload` (callback) | Send a chat message (auth required, rate-limited 5/min/user) |
| `join:notifications` | — (or explicit room string) | `room:joined` | Join personal notification room (auth required) |
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
