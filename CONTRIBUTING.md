# Contributing to Xelma Backend

Thanks for contributing! This guide covers the essentials. For deeper architecture
details, see [docs/architecture.md](docs/architecture.md) and the [README](README.md).

## Dual-entrypoint architecture

The repo ships **two Express applications**, and this is the single most common
source of contributor mistakes — several issues were closed while the
functionality existed in only one of them:

| Command | File | Use when |
| --- | --- | --- |
| `npm run dev` | `src/index.ts` | **Default.** Full backend — real DB, WebSocket, Soroban. Almost all work belongs here. |
| `npm run dev:hackathon` | `src/server.ts` (`src/app.ts`) | Mock/demo app, no database. |

**Always verify your change on the default `npm run dev` path before opening a PR.**
If your change touches functionality shared by both apps, verify it on the
hackathon entrypoint too.

## Development workflow

```bash
npm ci                 # install dependencies
npm run prisma:generate # generate the Prisma client
npm run dev            # start the default (production) dev server

npm run lint           # type-check (tsc --noEmit)
npm test               # run the test suite
npm run build          # compile to dist/
```

## Opening a pull request

1. Branch off `main`.
2. Make your change and add tests.
3. Run `npm run lint` and `npm test` locally.
4. Fill out every section of the pull request template, including the
   **Affected endpoints** list and the entrypoint-verification checklist.
5. Reference the issue you are closing (`Closes #123`).

The pull request template is applied automatically to new PRs from
[.github/pull_request_template.md](.github/pull_request_template.md).
