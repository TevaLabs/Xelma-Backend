/**
 * Environment variable resolution helpers.
 *
 * Supports canonical names with backward-compatible aliases so hackathon /
 * Render templates (CONTRACT_ID, STELLAR_RPC_URL) and production SOROBAN_*
 * names both work. Canonical SOROBAN_* names always win when both are set.
 */

export interface EnvResolution {
  /** Trimmed value, or undefined when unset / blank. */
  value: string | undefined;
  /** Env var name that supplied the value, or null when unset. */
  source: string | null;
}

/**
 * Resolve an env var preferring `canonical`, then each alias in order.
 * Empty / whitespace-only values are treated as unset.
 */
export function resolveEnv(
  env: NodeJS.ProcessEnv,
  canonical: string,
  aliases: readonly string[] = [],
): EnvResolution {
  for (const name of [canonical, ...aliases]) {
    const raw = env[name];
    if (raw !== undefined && raw.trim().length > 0) {
      return { value: raw.trim(), source: name };
    }
  }
  return { value: undefined, source: null };
}

/**
 * Canonical Soroban env names and accepted aliases (#404).
 * Keep the README "Soroban env alias matrix" table in sync with this map.
 */
export const SOROBAN_ENV_ALIASES = {
  contractId: {
    canonical: "SOROBAN_CONTRACT_ID",
    aliases: ["CONTRACT_ID"] as const,
  },
  rpcUrl: {
    canonical: "SOROBAN_RPC_URL",
    aliases: ["STELLAR_RPC_URL"] as const,
  },
} as const;

export interface ResolvedSorobanEnv {
  contractId: EnvResolution;
  rpcUrl: EnvResolution;
  network: string | undefined;
  adminSecret: string | undefined;
  oracleSecret: string | undefined;
}

/** Resolve Soroban-related env vars with alias support. */
export function resolveSorobanEnvVars(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSorobanEnv {
  return {
    contractId: resolveEnv(
      env,
      SOROBAN_ENV_ALIASES.contractId.canonical,
      SOROBAN_ENV_ALIASES.contractId.aliases,
    ),
    rpcUrl: resolveEnv(
      env,
      SOROBAN_ENV_ALIASES.rpcUrl.canonical,
      SOROBAN_ENV_ALIASES.rpcUrl.aliases,
    ),
    network: env.SOROBAN_NETWORK?.trim() || undefined,
    adminSecret: env.SOROBAN_ADMIN_SECRET?.trim() || undefined,
    oracleSecret: env.SOROBAN_ORACLE_SECRET?.trim() || undefined,
  };
}

function redactSecret(present: boolean): string {
  return present ? "[set]" : "[unset]";
}

function redactContractId(id: string | undefined): string {
  if (!id) return "[unset]";
  if (id.length <= 8) return "[set]";
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

/**
 * Safe-to-log summary of resolved Soroban config.
 * Secrets are never included — only presence flags / redacted identifiers.
 */
export function formatResolvedSorobanConfigForLog(
  resolved: ResolvedSorobanEnv,
  defaults?: { rpcUrl?: string; network?: string },
): Record<string, unknown> {
  const rpcUrl =
    resolved.rpcUrl.value ??
    defaults?.rpcUrl ??
    "https://soroban-testnet.stellar.org";
  const network = resolved.network ?? defaults?.network ?? "testnet";

  return {
    contractId: redactContractId(resolved.contractId.value),
    contractIdSource: resolved.contractId.source,
    rpcUrl,
    rpcUrlSource: resolved.rpcUrl.source ?? "(default)",
    network,
    adminSecret: redactSecret(Boolean(resolved.adminSecret)),
    oracleSecret: redactSecret(Boolean(resolved.oracleSecret)),
  };
}
