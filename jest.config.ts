import type { Config } from "jest";

const integrationTestFiles = [
  "auth.routes.spec.ts",
  "auth-audit-integration.spec.ts",
  "auth-race.spec.ts",
  "batch-routes.spec.ts",
  "concurrent-rounds.spec.ts",
  "db-pool-config.spec.ts",
  "decimal-precision.spec.ts",
  "education-tip.route.spec.ts",
  "error-response-consistency.spec.ts",
  "errorHandler.spec.ts",
  "idempotency.spec.ts",
  "leaderboard-cache.spec.ts",
  "leaderboard.routes.spec.ts",
  "monetary-precision.spec.ts",
  "notifications.routes.spec.ts",
  "performance.spec.ts",
  "prediction-concurrency.spec.ts",
  "predictions.routes.spec.ts",
  "rate-limit-visibility.spec.ts",
  "requestId.middleware.spec.ts",
  "requestId.spec.ts",
  "round.spec.ts",
  "rounds.routes.spec.ts",
  "security.spec.ts",
  "socket.spec.ts",
  "user.routes.spec.ts",
  "validate.middleware.spec.ts",
];

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
  coverageProvider: "v8",
  coverageDirectory: "<rootDir>/coverage",
  coverageReporters: ["text", "text-summary", "lcov", "cobertura"],
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.d.ts",
    "!src/**/*.types.ts",
    "!src/types/**",
    "!src/tests/**",
    "!src/__mocks__/**",
    "!src/scripts/**",
    "!src/index.ts",
    "!src/socket.ts",
    "!vendor/**",
  ],
  coveragePathIgnorePatterns: [
    "/node_modules/",
    "/dist/",
    "/coverage/",
    "/vendor/",
    "/src/__mocks__/",
    "/src/tests/",
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 50,
      lines: 35,
      statements: 35,
    },
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
    // Integration test files (DB, HTTP listener, or cross-service tests)
    ...integrationTestFiles,
  ],
  setupFiles: ["<rootDir>/jest.setup.js"],
};

// Integration tests - require PostgreSQL and services
const integrationConfig: Config = {
  ...baseConfig,
  displayName: "integration",
  testMatch: [
    `**/{${integrationTestFiles.map((file) => file.replace(".spec.ts", "")).join(",")}}.spec.ts`,
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
