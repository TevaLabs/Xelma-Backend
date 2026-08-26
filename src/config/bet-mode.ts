/**
 * Centralized bet-mode resolver.
 *
 * Returns `true` (stub) when:
 *   1. BET_STUB_MODE is explicitly set to "true", OR
 *   2. BET_STUB_MODE is unset / empty AND required Soroban config
 *      (contract id, admin secret, oracle secret) is absent — but ONLY
 *      in non-production (NODE_ENV !== "production").
 *
 * In production, missing secrets always cause an error — the server should
 * never silently downgrade to stub mode when real money is at stake.
 */

import { resolveSorobanEnvVars } from "./env";
import logger from "../utils/logger";

/**
 * Check whether all three Soroban "money-path" secrets are present.
 * Contract id + admin secret + oracle secret are required for on-chain
 * bets to function; RPC URL has a sensible default so it is NOT checked.
 */
export function hasSorobanSecrets(
  env: NodeJS.ProcessEnv = process.env,
): { ok: boolean; missing: string[] } {
  const resolved = resolveSorobanEnvVars(env);
  const missing: string[] = [];

  if (!resolved.contractId.value) missing.push("SOROBAN_CONTRACT_ID");
  if (!resolved.adminSecret) missing.push("SOROBAN_ADMIN_SECRET");
  if (!resolved.oracleSecret) missing.push("SOROBAN_ORACLE_SECRET");

  return { ok: missing.length === 0, missing };
}

/**
 * Resolve the effective bet mode.
 *
 * @param env - process.env by default; injectable for testing.
 * @returns true when bets should be stubbed locally.
 */
export function isBetStubMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const explicit = env.BET_STUB_MODE?.trim().toLowerCase();

  // Explicit opt-in: BET_STUB_MODE=true → always stub
  if (explicit === "true") return true;

  // Explicit opt-out: BET_STUB_MODE=false → always on-chain
  if (explicit === "false") return false;

  // BET_STUB_MODE is unset / empty — derive from environment.

  const isProduction =
    (env.NODE_ENV ?? "development") === "production";

  const { ok: hasSecrets, missing } = hasSorobanSecrets(env);

  if (hasSecrets) {
    // Secrets are present — try on-chain (caller wanted unset → default on-chain).
    return false;
  }

  // Secrets are missing.
  if (isProduction) {
    // Production must never silently fall back to stub.
    logger.error(
      "BET_STUB_MODE is unset but required Soroban secrets are missing in production. " +
        "Falling back to stub mode is NOT safe for real-money deployments.",
      { missing },
    );
    // Return false (on-chain) so the real error surfaces at the Soroban layer,
    // rather than masking a misconfiguration.
    return false;
  }

  // Non-production with missing secrets → safe to stub.
  logger.warn(
    "BET_STUB_MODE unset and Soroban secrets missing — defaulting to STUB mode for local/demo. " +
      "Set BET_STUB_MODE=true explicitly to silence this warning.",
    { missing },
  );
  return true;
}

/**
 * Log the resolved bet mode once at startup.
 * Call from src/index.ts after config is loaded.
 */
export function logResolvedBetMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const stub = isBetStubMode(env);
  logger.info(
    `Bet mode resolved: ${stub ? "STUB (no on-chain calls)" : "ON-CHAIN (Soroban)"}`,
    { BET_STUB_MODE: env.BET_STUB_MODE ?? "(unset)", resolved: stub },
  );
  return stub;
}

/**
 * Assert that production environments have all required Soroban secrets.
 * Called from startup to fail-fast when misconfigured.
 *
 * @throws never — logs a warning instead. The caller (isBetStubMode) already
 *   handles the production-missing-secrets case by returning false so the
 *   real error surfaces later. This function exists solely to produce a
 *   clear startup-time log line.
 */
export function warnIfProductionMissingSecrets(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const isProduction = (env.NODE_ENV ?? "development") === "production";
  if (!isProduction) return;

  const { ok, missing } = hasSorobanSecrets(env);
  if (!ok) {
    logger.error(
      "Production deployment is missing required Soroban secrets. " +
        "Bets will fail at the Soroban layer. Set the following env vars: " +
        missing.join(", "),
      { missing },
    );
  }
}
