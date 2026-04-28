import type { Config } from "jest";

// Base configuration shared between unit and integration tests
const baseConfig: Partial<Config> = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testPathIgnorePatterns: [
    "/node_modules/"
  ],
  moduleFileExtensions: ["ts", "js", "json"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json" }],
  },
  clearMocks: true,
  moduleNameMapper: {
    "^@tevalabs/xelma-bindings$": "<rootDir>/src/__mocks__/xelma-bindings.ts",
  },
};

// Unit tests - fast, no external dependencies
const unitConfig: Config = {
  ...baseConfig,
  displayName: "unit",
  testMatch: [
    "**/*.spec.ts",
  ],
  testPathIgnorePatterns: [
    "/node_modules/",
    // Integration test files (DB tests)
    "rounds.routes.spec.ts",
    "predictions.routes.spec.ts",
    "round.spec.ts",
    "concurrent-rounds.spec.ts",
    "education-tip.route.spec.ts",
    "auth-race.spec.ts",
    "prediction-concurrency.spec.ts",
    "idempotency.spec.ts",
    "db-pool-config.spec.ts",
    "decimal-precision.spec.ts",
    "monetary-precision.spec.ts",
    "leaderboard-cache.spec.ts",
    "auth-audit-integration.spec.ts",
  ],
  setupFiles: ["<rootDir>/jest.setup.js"],
};

// Integration tests - require PostgreSQL and services
const integrationConfig: Config = {
  ...baseConfig,
  displayName: "integration",
  testMatch: [
    "**/{rounds.routes,predictions.routes,round,concurrent-rounds,education-tip.route,auth-race,prediction-concurrency,idempotency,db-pool-config,decimal-precision,monetary-precision,leaderboard-cache,auth-audit-integration}.spec.ts",
  ],
  setupFiles: ["<rootDir>/jest.setup.js"],
  // Integration tests can have longer timeouts
  testTimeout: 30000,
};

// Determine which config to use based on TEST_TYPE env var
const testType = process.env.TEST_TYPE || "all";
let config: Config;

if (testType === "unit") {
  config = unitConfig;
} else if (testType === "integration") {
  config = integrationConfig;
} else {
  // Default: run both (for local development and backward compatibility)
  config = {
    ...baseConfig,
    testMatch: ["**/*.spec.ts"],
    setupFiles: ["<rootDir>/jest.setup.js"],
    projects: [unitConfig, integrationConfig],
  };
}

export default config;
