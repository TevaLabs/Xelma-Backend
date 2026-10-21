# Pagination contract

Canonical pagination metadata for every list endpoint (issue #340).

Clients should be able to implement **one** pagination parser and use it against
tournaments, user history, leaderboard, chat history and notifications.

## Canonical shape

All paginated responses put their metadata under `pagination`:

```jsonc
// Offset mode
{
  "success": true,
  "data": [ /* … */ ],
  "pagination": {
    "limit": 20,
    "offset": 0,
    "total": 42,
    "totalPages": 3,
    "hasNextPage": true
  }
}
```

```jsonc
// Cursor mode
{
  "success": true,
  "data": [ /* … */ ],
  "pagination": {
    "limit": 20,
    "nextCursor": "eyJjcmVhdGVkQXQiOi…",
    "hasNextPage": true
  }
}
```

| Key | Offset mode | Cursor mode | Meaning |
| --- | --- | --- | --- |
| `limit` | always | always | Page size the server applied |
| `offset` | always | absent | Rows skipped |
| `total` | always | absent | Rows across all pages |
| `totalPages` | always | absent | `ceil(total / limit)` |
| `nextCursor` | absent | always (`null` on the last page) | Opaque cursor for the next page |
| `hasNextPage` | always | always | `true` when more rows exist |

Rules:

- `hasNextPage` is the single source of truth for "is there another page".
- `nextCursor === null` means the last page; loop until then.
- `offset` and `total` are never sent in cursor mode, and `nextCursor` is never
  sent in offset mode. Use `hasNextPage` to branch when a client supports both.
- `totalPages` is `0` when `total` is `0`.

## Helpers

Use the shared builders in
[`src/utils/pagination.util.ts`](../utils/pagination.util.ts) rather than
hand-rolling the object:

```ts
import {
  buildUnifiedOffsetPagination,
  buildUnifiedCursorPagination,
} from "../utils/pagination.util";

return sendSuccess(res, rows, {
  pagination: buildUnifiedOffsetPagination(limit, offset, total),
});
```

## Endpoints

| Endpoint | Modes | Notes |
| --- | --- | --- |
| `GET /api/tournaments` | offset | `meta.pagination` (uses the standard success envelope) |
| `GET /api/user/:address/history` | offset + cursor | cursor when `cursor` is passed, otherwise offset |
| `GET /api/leaderboard` | offset + cursor | cursor when `cursor` is passed, otherwise offset |
| `GET /api/chat/history` | offset + cursor | capped at 50 messages per page |
| `GET /api/notifications` | offset + cursor | cursor when `cursor` is passed, otherwise offset |

When `cursor` is supplied, `offset` is ignored.

## Backward compatibility

The unified metadata is additive, but a few legacy fields are still emitted so
existing clients keep working:

| Endpoint | Legacy field | Status |
| --- | --- | --- |
| `GET /api/notifications` (offset) | top-level `total`, `limit`, `offset` | Kept; mirrors `pagination.*` |
| `GET /api/notifications` (cursor) | top-level `nextCursor` | Kept; mirrors `pagination.nextCursor` |
| `GET /api/user/:address/history` (cursor) | top-level `nextCursor` | Kept; mirrors `pagination.nextCursor` |
| `GET /api/chat/history` (offset) | top-level `count` | Kept; number of messages in this page |

Notes:

- No key was renamed or removed, so a client that only reads the legacy fields
  continues to work unchanged.
- `meta.pagination` on tournaments now also includes `hasNextPage` and
  `totalPages`. Clients using strict object equality on that object must
  tolerate the additional keys; clients reading `limit` / `offset` / `total` are
  unaffected.
- Leaderboard offset responses keep `totalUsers` alongside `pagination.total`
  for clients that used it before pagination metadata existed.
- The legacy fields are deprecated for new clients: read `pagination` instead.

## Tests

- `src/tests/pagination.util.spec.ts` — helper units (offset, cursor, unified).
- `src/tests/tournaments.list.spec.ts` — tournaments metadata shape.
- `src/tests/leaderboard.routes.spec.ts` — leaderboard offset + cursor meta.
- `src/tests/chat.routes.spec.ts` — chat history meta.
- `src/tests/notifications.routes.spec.ts` — notifications meta + legacy fields.
