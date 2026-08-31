# Contributing to Xelma Backend

Thanks for contributing! This guide covers the essentials. For deeper architecture
details, see [docs/architecture.md](docs/architecture.md) and the [README](README.md).

## Entrypoints and the app factory

The repo ships **two Express applications**, but only **one** of them owns HTTP
wiring. [`src/app-factory.ts`](src/app-factory.ts) builds both; the entrypoints
only choose a mode.

| Command | Entrypoint | Mode | Use when |
| --- | --- | --- | --- |
| `npm run dev` | `src/index.ts` | `full` | **Default.** Full backend — real DB, WebSocket, Soroban. Almost all work belongs here. |
| `npm run dev:hackathon` | `src/server.ts` → `src/app.ts` | `hackathon` | Mock/demo app, no database. |

```ts
// src/index.ts
createAppFromFactory({ mode: 'full' });

// src/app.ts
createAppFromFactory({ mode: 'hackathon' });
```

Route mounting, middleware order, CORS, security headers, rate limiting, the
OpenAPI spec and the error handlers all live in the factory. **Adding a route in
one entrypoint but not the other is no longer possible by accident** — the two
apps read the same mounting code, and everything that differs is an explicit
feature flag.

### Feature flags

Every surface that exists in only one app is a flag on `AppFeatures` in
[`src/app-factory.ts`](src/app-factory.ts):

| Flag | Surface it gates | `full` | `hackathon` |
| --- | --- | --- | --- |
| `auth` | `/api/auth/*` — wallet challenge/connect | on | on |
| `predictions` | `/api/predictions/*` | on | off |
| `education` | `/api/education/*` | on | off |
| `errorCatalog` | `GET /api/errors` | on | off |
| `adminRoutes` | `/api/admin/metrics`, `/api/admin/cors-diagnostics`, `/api/admin/dead-letter` | on | off |
| `versionedAlias` | mirrors every `/api/*` route under `/api/v1/*` | on | off |
| `deprecationHeaders` | `Deprecation` / `Sunset` / `Link` headers on unversioned `/api/*` | on | off |
| `globalApiRateLimit` | applies the read/write limiters to all of `/api` | off | on |
| `platformStats` | `GET /api/stats` | off | on |
| `multiplayerSocial` | `/api/chat`, `/api/notifications` (also gated by `ENABLE_MULTIPLAYER_SOCIAL`) | on | on |
| `legacyPriceEndpoint` | `GET /api/price` (single-asset XLM) | on | off |
| `rootBanner` | `GET /` welcome banner | on | off |
| `apiDocs` | Swagger UI and `/api-docs.json` | on | on |

Two further differences are driven by the mode rather than a flag, because the
two apps deliberately serve different implementations:

| Surface | `full` | `hackathon` |
| --- | --- | --- |
| Rounds router | `src/routes/rounds.routes.ts` (production) | `src/routes/rounds.ts` (mock) |
| Leaderboard router | `src/routes/leaderboard.routes.ts` | `src/routes/leaderboard.ts` |
| Prices router | `src/routes/prices.ts` (raw snapshot) | `src/routes/index.ts` (success envelope) |
| Health mount | `GET /health` | `GET /api`, `GET /api/health` |
| OpenAPI spec | `src/docs/openapi.ts` | `src/docs/hackathon-openapi.ts` |
| Error handler | `middleware/errorHandler.middleware.ts` | `middleware/errorHandler.ts` |

Security headers are *not* mode-dependent: both apps register the shared
`middleware/securityHeaders.middleware.ts` (helmet plus an explicit CSP,
`X-XSS-Protection` and `Permissions-Policy`).

Flags can be overridden per call, which is mostly useful in tests:

```ts
createApp({ mode: 'full', features: { adminRoutes: false } });
```

### Adding a route

1. Add it to `mountApiRoutes()` in `src/app-factory.ts`. It is then served by
   **both** apps and mirrored under `/api/v1` automatically.
2. If it should exist in only one app, gate it behind a feature flag — add a new
   one to `AppFeatures` if none fits.
3. Add a matching entry to `PARITY_ALLOWLIST` in
   [`src/security/route-parity.registry.ts`](src/security/route-parity.registry.ts),
   including the `flag` field naming the flag responsible.

`src/tests/route-parity.spec.ts` fails if a route appears in one app without an
allowlist entry, if an allowlist entry goes stale, or if an entry has no `flag`
or `reason`. That test is the guard against the drift this structure exists to
prevent.

**Always verify your change on the default `npm run dev` path before opening a PR.**
If your change touches functionality shared by both apps, verify it on the
hackathon entrypoint too.

## Development workflow

```bash
npm ci                 # install dependencies
npm run db:prepare     # generate the Prisma client and apply all migrations
npm run dev            # start the default (production) dev server

npm run lint           # type-check (tsc --noEmit)
npm test               # run the test suite
npm run build          # compile to dist/
```

## Database migrations

Prisma is the single database ORM and migration tool. The schema lives in
`prisma/schema.prisma`, and committed migrations live under
`prisma/migrations/`. Run `npm run db:prepare` to generate the Prisma client
and apply migrations, or use `npm run prisma:migrate` when changing the schema.
See the README "Migration story" section for more detail.

## Keeping the repo root clean

Accidental empty files at the repo root (e.g. `src*.ts` leftovers from misplacing
entries while creating new files) clutter search results and confuse contributors.
Before committing, run `git status --short` and delete any zero-byte or stray
`.ts` files that do not belong at the root. If your new file lives under `src/`,
make sure it is created there — not at the repository root.

## Opening a pull request

1. Branch off `main`.
2. Make your change and add tests.
3. Run `npm run lint` and `npm test` locally.
4. Fill out every section of the pull request template, including the
   **Affected endpoints** list and the entrypoint-verification checklist.
5. Reference the issue you are closing (`Closes #123`).

The pull request template is applied automatically to new PRs from
[.github/pull_request_template.md](.github/pull_request_template.md).

## Runtime modes

Before opening a PR, verify your change works under the appropriate runtime
mode flags. The authoritative matrix of `DATA_MODE`, `BET_STUB_MODE`,
`ROUNDS_MOCK_MODE`, and their interactions lives in
**[docs/runtime-modes.md](docs/runtime-modes.md)**.
