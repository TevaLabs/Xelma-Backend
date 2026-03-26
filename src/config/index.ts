import dotenv from "dotenv";
import { createValidator, ConfigValidationError } from "./validation";

dotenv.config();

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

export interface AppConfig {
  port: number;
  nodeEnv: "development" | "production" | "test";
  clientUrl: string;
  logLevel: string;
}

export interface JwtConfig {
  secret: string;
  expiry: string;
}

export interface DatabaseConfig {
  url: string;
}

export interface SorobanConfig {
  contractId: string;
  network: "testnet" | "mainnet";
  rpcUrl: string;
  adminSecret: string;
  oracleSecret: string;
}

export interface SchedulerConfig {
  autoResolveEnabled: boolean;
  autoResolveIntervalSeconds: number;
  roundSchedulerEnabled: boolean;
  roundSchedulerMode: "UP_DOWN" | "LEGENDS";
}

export interface StellarConfig {
  network: "testnet" | "mainnet";
}

export interface SocketConfig {
  clientUrl: string;
}

export interface Config {
  app: AppConfig;
  jwt: JwtConfig;
  database: DatabaseConfig;
  soroban: SorobanConfig;
  scheduler: SchedulerConfig;
  stellar: StellarConfig;
  socket: SocketConfig;
}

// ---------------------------------------------------------------------------
// Build & validate
// ---------------------------------------------------------------------------

function buildConfig(): Config {
  const v = createValidator();
  const env = process.env;

  const app: AppConfig = {
    port: v.port(env.PORT, "PORT", 3000),
    nodeEnv: v.oneOf(
      env.NODE_ENV,
      "NODE_ENV",
      ["development", "production", "test"] as const,
      "development",
    ),
    clientUrl: v.optional(env.CLIENT_URL, "*"),
    logLevel: v.oneOf(
      env.LOG_LEVEL,
      "LOG_LEVEL",
      ["error", "warn", "info", "http", "verbose", "debug", "silly"] as const,
      "info",
    ),
  };

  const jwt: JwtConfig = {
    secret: v.sensitiveRequired(env.JWT_SECRET, "JWT_SECRET"),
    expiry: v.optional(env.JWT_EXPIRY, "7d"),
  };

  const database: DatabaseConfig = {
    url: v.required(env.DATABASE_URL, "DATABASE_URL"),
  };

  const sorobanNetwork = v.oneOf(
    env.SOROBAN_NETWORK,
    "SOROBAN_NETWORK",
    ["testnet", "mainnet"] as const,
    "testnet",
  );

  const soroban: SorobanConfig = {
    contractId: v.optional(env.SOROBAN_CONTRACT_ID, ""),
    network: sorobanNetwork,
    rpcUrl: v.url(
      env.SOROBAN_RPC_URL,
      "SOROBAN_RPC_URL",
      "https://soroban-testnet.stellar.org",
    ),
    adminSecret: v.optional(env.SOROBAN_ADMIN_SECRET, ""),
    oracleSecret: v.optional(env.SOROBAN_ORACLE_SECRET, ""),
  };

  const scheduler: SchedulerConfig = {
    autoResolveEnabled: v.boolean(env.AUTO_RESOLVE_ENABLED, false),
    autoResolveIntervalSeconds: v.positiveInt(
      env.AUTO_RESOLVE_INTERVAL_SECONDS,
      "AUTO_RESOLVE_INTERVAL_SECONDS",
      30,
    ),
    roundSchedulerEnabled: v.boolean(env.ROUND_SCHEDULER_ENABLED, false),
    roundSchedulerMode: v.oneOf(
      env.ROUND_SCHEDULER_MODE,
      "ROUND_SCHEDULER_MODE",
      ["UP_DOWN", "LEGENDS"] as const,
      "UP_DOWN",
    ),
  };

  const stellar: StellarConfig = {
    network: v.oneOf(
      env.STELLAR_NETWORK,
      "STELLAR_NETWORK",
      ["testnet", "mainnet"] as const,
      "testnet",
    ),
  };

  const socket: SocketConfig = {
    clientUrl: app.clientUrl,
  };

  // Fail fast — surface every invalid field at once
  v.throwIfErrors();

  return { app, jwt, database, soroban, scheduler, stellar, socket };
}

// ---------------------------------------------------------------------------
// Singleton export — parsed and validated once at module load time.
// Any import of this module triggers validation; if it fails the process
// logs every error and exits with code 1.
// ---------------------------------------------------------------------------

let _config: Config;

try {
  _config = buildConfig();
} catch (err) {
  if (err instanceof ConfigValidationError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const config: Readonly<Config> = Object.freeze(_config);
export default config;
