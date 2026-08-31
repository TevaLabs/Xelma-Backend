# Upgrading the vendored Soroban bindings

`@tevalabs/xelma-bindings` is generated from the Soroban contract in
[Xelma-Blockchain](https://github.com/TevaLabs/Xelma-Blockchain) and **vendored
into this repo** at `vendor/xelma-bindings` (`package.json` declares it as
`file:vendor/xelma-bindings`). npm cannot install from a Git subdirectory, so
`scripts/install-bindings.js` sparse-checks out `bindings/`, builds ESM + CJS,
and copies the result in.

Because the client is generated, an upstream contract change can silently
remove a method or rename an argument that `src/services/soroban.service.ts`
still calls. That failure surfaces as an opaque RPC error on a money path,
usually under campaign load. The checks below turn it into a red CI job.

---

## The pin: `bindings.pin.json`

`bindings.pin.json` at the repo root is the **single source of truth**. It sits
outside `vendor/` on purpose, so `rm -rf vendor/xelma-bindings` cannot take the
expected revision with it.

| Key | Meaning |
|---|---|
| `repository`, `ref` | Upstream source the bindings are generated from |
| `commitSha` | Exact upstream commit the vendored build must come from |
| `packageName` | Name `vendor/xelma-bindings/package.json` must declare |
| `requiredArtifacts` | Build outputs that must exist (ESM, CJS, `.d.ts`, manifest) |
| `requiredValueExports` | Runtime exports the backend imports (`Client`, `RoundMode`) |
| `requiredTypeExports` | Types the backend imports (`Round`, `BetSide`, `OraclePayload`, `UserStats`) |
| `requiredEnumMembers` | Enum members the backend branches on |
| `requiredTypeFields` | Struct fields the backend reads (e.g. `Round.price_start`) |
| `requiredMethods` | Contract method → argument names `soroban.service.ts` passes |

`requiredMethods` deliberately lists **only** what the backend calls. Upstream
is free to add or change anything else without breaking this repo's CI.

## What is verified, and where

`src/utils/bindings-validator.ts` asserts three independent layers:

1. **Revision** — `vendor/xelma-bindings/.commit-sha` equals `commitSha`, the
   manifest name matches, and every `requiredArtifacts` entry exists.
2. **TypeScript surface** — `dist/index.d.ts` exports the required types and
   declares every required `Client` method with the expected argument names.
3. **Contract ABI** — the Soroban contract spec embedded in `dist/index.js` as
   base64 XDR declares each required function *with those arguments*. This is
   the only layer that inspects the real on-chain interface instead of
   generated TypeScript, so it catches a stale or partial rebuild that still
   type-checks.

| Where | Command | Covers |
|---|---|---|
| CI job `vendored bindings pin` | `npm run check:bindings` | Layer 1, no install needed — fails in seconds |
| CI job `vendored bindings contract surface` | `npm run check:bindings:abi` | Layers 1–3, runs on the built `dist/` |
| Local | `npm run check:bindings && npm run build && npm run check:bindings:abi` | All layers |
| Startup | automatic, see below | All layers |

## Startup policy

`src/index.ts` runs the same validation on boot. The enforcement level comes
from `resolveBindingsPolicy()`:

| Environment | Policy |
|---|---|
| `BINDINGS_CHECK=off` \| `warn` \| `strict` | Explicit override, always wins |
| `NODE_ENV=production` + contract ID set + `BET_STUB_MODE` not `true` | **strict** |
| `SOROBAN_FAIL_CLOSED=true` + contract ID set | **strict** |
| Everything else (local dev, tests, API-only, stubbed deployments) | warn |

**strict** logs the errors plus remediation steps and exits with code 1 — the
process refuses to start rather than serve traffic with a possibly-mismatched
contract client. **warn** logs the same detail and continues, so an API-only
deployment that never touches Soroban is never blocked by a missing vendor.

---

## Procedure: upgrading to a new contract revision

1. **Pick the commit.** Review the upstream diff in `Xelma-Blockchain` and note
   the full 40-character SHA. Never point the pin at a branch.

2. **Update the pin.** Set `commitSha` in `bindings.pin.json`.

3. **Rebuild the vendor:**

   ```bash
   node scripts/install-bindings.js --refresh
   ```

   This fetches that exact commit, builds ESM and CJS, patches the manifest,
   and writes `vendor/xelma-bindings/.commit-sha`. Never hand-edit
   `.commit-sha` — it is the proof of what the checked-in `dist/` was built
   from.

4. **Reconcile the surface.** If the contract interface changed, update
   `bindings.pin.json` (`requiredMethods`, `requiredTypeExports`,
   `requiredTypeFields`, …) **and** `src/services/soroban.service.ts` in the
   same commit. The pin is a statement of what the backend needs; loosening it
   to make CI pass without changing the caller is the failure mode this whole
   mechanism exists to prevent.

5. **Verify locally:**

   ```bash
   npm run check:bindings          # revision + artifacts
   npm run lint                    # tsc against the new .d.ts
   npm run build
   npm run check:bindings:abi      # full surface + contract ABI
   npm run test:unit
   ```

6. **Commit the vendored build.** `vendor/xelma-bindings/dist/**` and
   `.commit-sha` are checked in; the PR diff should show the regenerated
   client alongside the pin bump.

## Troubleshooting

| Message | Cause | Fix |
|---|---|---|
| `Bindings commit skew: … .commit-sha is X, but bindings.pin.json pins Y` | Vendor built from a different commit than the pin | `node scripts/install-bindings.js --refresh` |
| `Contract method \`x\` is missing from the bindings Client interface` | Upstream removed/renamed a method the backend calls | Update `soroban.service.ts` and the pin together |
| `Contract method \`x\` no longer accepts argument \`y\`` | Signature changed upstream | Update the call site and `requiredMethods` |
| `Contract method \`x\` is absent from the ESM/CJS build` | Stale or partial build (`dist/` older than `.d.ts`) | `node scripts/install-bindings.js --refresh` |
| `Contract ABI mismatch: … does not declare a \`x\` function` | The embedded contract spec disagrees with the generated TS — vendor is inconsistent | `node scripts/install-bindings.js --refresh`, then re-check upstream |
| `Missing bindings.pin.json` | Running from outside the repo root, or the pin was deleted | Run from the repo root; restore the pin from git |
| `Could not locate the embedded contract spec` (warning) | Upstream restructured the generated client | Non-fatal; update `decodeSpecEntries()` in the validator |
