# Distributed tracing: requestId ↔ txHash correlation

This document explains how to trace a single client request from HTTP → DB → Soroban chain → outbox using the `requestId` and `txHash` correlation fields introduced in Issue #496.

## Overview

- Every HTTP request gets a `requestId` (UUID or incoming `X-Request-ID` header) from `requestIdMiddleware` (`src/middleware/requestId.middleware.ts`).
- The `requestId` is propagated via `AsyncLocalStorage` (`src/utils/requestContext.ts`) so downstream services (`Soroban`, `bet-audit`, `outbox`) can include it without explicit param threading.
- Services also build a `correlationId` that links `requestId` and `txHash`: `"<requestId>:<txHash>"` (or just `requestId` when txHash is not yet known). This indexed field makes searching across logs/audit/outbox trivial.
- All bet/claim logs include `requestId` and `txHash` together; outbox events carry both as `requestId`/`correlationId` payload fields; audit events persist them in `AuditLog.metadata`.

## How to trace a failed bet

1. **Find the requestId** from the client response header or logs:
   ```
   X-Request-ID: 123e4567-e89b-12d3-a456-426614174000
   ```

2. **Search logs** for that requestId (Winston JSON):
   ```bash
   # All Soroban calls for the request
   jq 'select(.requestId=="123e4567-e89b-12d3-a456-426614174000")' logs/app.json

   # Failed bet logs specifically
   jq 'select(.requestId=="123e4567-e89b-12d3-a456-426614174000" and .level=="error")'
   ```

3. **Query audit events** (in-memory or DB):
   ```sql
   SELECT event, mode, result, txHash, metadata->>'requestId' as requestId, metadata->>'correlationId' as correlationId
   FROM "AuditLog"
   WHERE metadata->>'requestId' = '123e4567-e89b-12d3-a456-426614174000'
   ORDER BY timestamp DESC;

   -- By correlationId (links directly to txHash)
   SELECT * FROM "AuditLog"
   WHERE metadata->>'correlationId' LIKE '123e4567-e89b-12d3-a456-426614174000:%';
   ```

4. **Check outbox** for correlation:
   ```sql
   SELECT eventType, payload->>'requestId', payload->>'correlationId', payload->>'txHash', status
   FROM "OutboxEvent"
   WHERE payload->>'requestId' = '123e4567-e89b-12d3-a456-426614174000';
   ```

5. **Verify on-chain** via `txHash` from audit/outbox:
   ```bash
   curl -s $SOROBAN_RPC_URL -X POST -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"getTransaction","params":{"hash":"<txHash>"}}' | jq
   ```

## Outbox correlation example

A `BET_ACCEPTED` outbox payload now looks like:
```json
{
  "betId": "bet_123",
  "userId": "user_456",
  "mode": "UP_DOWN",
  "state": "accepted",
  "txHash": "abc123...",
  "requestId": "123e4567-e89b-12d3-a456-426614174000",
  "correlationId": "123e4567-e89b-12d3-a456-426614174000:abc123..."
}
```

Searchable fields: `requestId`, `txHash`, `correlationId`.

## Log correlation example

Soroban log lines now include both fields:
```json
{
  "level": "info",
  "message": "Bet placed successfully on Soroban",
  "requestId": "123e4567-e89b-12d3-a456-426614174000",
  "txHash": "abc123...",
  "correlationId": "123e4567-e89b-12d3-a456-426614174000:abc123...",
  "userAddress": "G...",
  "durationMs": 123
}
```

Filter with:
```
requestId=123e4567-e89b-12d3-a456-426614174000 AND txHash=abc123
```

## Testing

- `src/tests/requestId.middleware.spec.ts` verifies `requestId` propagation via AsyncLocalStorage.
- `src/tests/bet-audit.spec.ts` (extended) asserts audit events carry `requestId`/`correlationId`.
- `src/tests/outbox` asserts outbox payloads carry correlation ids.
- `src/tests/soroban.service.spec.ts` (manual) checks log fields.

## Redis adapter note

For multi-instance tracing, ensure `REDIS_URL` is set so the Redis adapter and distributed locks share the same instance. See `docs/multi-instance-deployment.md` and `src/utils/socket-adapter.ts` for adapter config.
