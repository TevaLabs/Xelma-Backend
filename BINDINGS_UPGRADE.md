# Bindings Upgrade Procedure

This document describes how to upgrade the vendored `@tevalabs/xelma-bindings` package when the contract ABI changes.

## Overview

The backend vendors `@tevalabs/xelma-bindings` from the [Xelma-Blockchain](https://github.com/TevaLabs/Xelma-Blockchain) repository. The vendored copy must match the contract ABI used by the deployed Soroban contract. Version skew causes runtime failures that are expensive to debug.

## Detection

The following mechanisms detect bindings version skew:

1. **CI pipeline** — The `bindings-drift` job in `.github/workflows/ci.yml` runs `scripts/validate-bindings.js` on every push and PR. It fails if:
   - Structural files are missing (dist, package.json)
   - Commit SHA does not match `.bindings-metadata.json`
   - Required Client methods or module exports are missing

2. **Startup validation** — The backend logs warnings/errors at startup via `src/utils/bindings-validator.ts`:
   - Structural checks run synchronously (warnings)
   - API surface checks run asynchronously before server start (errors)
   - Set `FAIL_ON_BINDINGS_MISMATCH=true` to abort startup on skew

## Upgrade Steps

### 1. Update the vendored bindings

```bash
npm run install-bindings
```

This script:
- Sparse-clones the `bindings/` directory from `Xelma-Blockchain` main branch
- Builds both ESM and CJS outputs
- Writes `.commit-sha` with the upstream commit hash
- Copies the result to `vendor/xelma-bindings/`

### 2. Verify the new bindings

```bash
node scripts/validate-bindings.js
```

This runs the same checks as CI. Confirm it passes before committing.

### 3. Update metadata (if ABI changed)

If the new bindings add/remove methods or exports, update `.bindings-metadata.json`:

```json
{
  "expectedCommitSha": "<new-sha-from-.commit-sha>",
  "requiredClientMethods": [
    "balance",
    "get_admin",
    "place_bet",
    "... add/remove as needed ..."
  ],
  "requiredExports": [
    "Client",
    "BetSide",
    "RoundMode",
    "... add/remove as needed ..."
  ]
}
```

**How to find the required methods:** Check `src/services/soroban.service.ts` for all `this.client.*` calls. Each method used there must be in `requiredClientMethods`.

**How to find the required exports:** Check all files that import from `@tevalabs/xelma-bindings` (including type imports). Each imported name must be in `requiredExports`.

### 4. Run tests

```bash
npm run test:unit -- --testPathPattern=bindings-validator
```

### 5. Commit

```bash
git add vendor/xelma-bindings/ .bindings-metadata.json
git commit -m "chore: upgrade xelma-bindings to <short-sha>"
```

## CI Failure Remediation

If the `bindings-drift` CI job fails:

1. Check the error message — it will say which methods/exports are missing or which SHA doesn't match
2. Run `npm run install-bindings` to fetch the latest bindings
3. If the ABI changed, update `.bindings-metadata.json` with the new SHA and surface
4. Run `node scripts/validate-bindings.js` locally to verify
5. Commit and push

## Environment Variables

| Variable | Purpose |
|---|---|
| `FAIL_ON_BINDINGS_MISMATCH` | Set to `true` to abort startup on version skew (recommended for production) |
| `NODE_ENV` | When `test`, node version check is skipped |
