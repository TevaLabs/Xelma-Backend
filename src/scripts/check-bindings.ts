#!/usr/bin/env node
/**
 * CI/local gate for vendored-bindings skew.
 *
 * Runs the full validation in src/utils/bindings-validator.ts — pinned commit,
 * build artifacts, TypeScript surface and the embedded Soroban contract ABI —
 * against bindings.pin.json, and exits non-zero on any mismatch so a drifted
 * vendor/xelma-bindings can never reach production traffic.
 *
 *   npm run build && npm run check:bindings:abi
 *
 * Deliberately dependency-free (no logger, no config) so it runs from a bare
 * dist/ artifact in CI.
 */
import {
  formatBindingsReport,
  validateVendoredBindings,
} from "../utils/bindings-validator";

function main(): void {
  const result = validateVendoredBindings();

  process.stdout.write(`${formatBindingsReport(result)}\n`);

  if (!result.ok) {
    process.stdout.write(
      `\n[check-bindings] FAILED — ${result.errors.length} problem(s) with vendor/xelma-bindings.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `\n[check-bindings] OK — vendored bindings match bindings.pin.json ` +
      `(${result.info.declaredMethods.length} client methods declared, ` +
      `${result.info.specMethods.length} required methods verified against the contract spec).\n`,
  );
}

main();
