# 🔌 Socket.IO Client Contract Documentation

This document defines the real-time event contract, lifecycle events, and type structures for the Xelma Backend gateway (`src/socket.ts`). It is designed to allow any contributor or frontend engineer to fully integrate real-time tracking without needing to dig into the source code.

---

## 🧭 Connection Lifecycle & Authentication

### 1. Connection Requirements
Connections are established using the standard Socket.IO client library against the root namespace (`/`). Authentication requires a valid JSON Web Token (JWT) provided in the initial handshake payload.

* **Production Gateway URL:** `https://api.tevalabs.com`
* **Protocol:** WebSocket / Polling fallback

```typescript
import { io } from "socket.io-client";

const socket = io("[https://api.tevalabs.com](https://api.tevalabs.com)", {
  auth: {
    token: "YOUR_JWT_ACCESS_TOKEN"
  },
  autoConnect: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000
});