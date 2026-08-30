import type { Config } from "@jest/types";
type JestConfig = Config.InitialOptions;

const integrationTestFiles = [
  "auth.routes.spec.ts",
  "auth-audit-integration.spec.ts",
  "auth-race.spec.ts",
  "batch-routes.spec.ts",
  "bets-idempotency-concurrency.spec.ts",
  "bets-idempotency-redis-outage.spec.ts",
  "bets.routes.spec.ts",
  "concurrent-rounds.spec.ts",
  "db-pool-config.spec.ts",
  "decimal-precision.spec.ts",
  "education-tip.route.spec.ts",
  "error-response-consistency.spec.ts",
  "errorHandler.spec.ts",
  "hackathon-atomic-bets.spec.ts",
  "hackathon.http.spec.ts",
  "idempotency.spec.ts",
  "leaderboard-cache.spec.ts",
  "leaderboard.routes.spec.ts",
  "monetary-precision.spec.ts",
  "notifications.routes.spec.ts",
  "performance.spec.ts",
  "prediction-concurrency.spec.ts",
  "tournament-concurrency.spec.ts",
  "tournament-lifecycle.spec.ts",
  "predictions.routes.spec.ts",
  "rate-limit-visibility.spec.ts",
  "requestId.middleware.spec.ts",
  "requestId.spec.ts",
  "resolution-concurrency.spec.ts",
  "resolution-fail-closed.spec.ts",
  "round.spec.ts",
  "rounds.routes.spec.ts",
  "round.service.active.spec.ts",
  "rounds-active.routes.spec.ts",
  "error.spec.ts",
  "data-mode.spec.ts",
  "security.spec.ts",
  "hackathon-endpoints.spec.ts",
  "monetary-serialization.spec.ts",
  "tournaments.routes.spec.ts",
  "route-parity.spec.ts",
  "socket.spec.ts",
  "user.routes.spec.ts",
  "validate.middleware.spec.ts",
  "redis-adapter.spec.ts",
];

// Base configuration shared between unit and integration tests
const baseConfig: Partial<JestConfig> = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testPathIgnorePatterns: [
    "/node_modules/"
  ],
  transformIgnorePatterns: [
    "/node_modules/(?!(@stellar|@noble|@tevalabs|uint8array-extras)/)"
  ],
  moduleFileExtensions: ["ts", "js", "json"],
  transform: {
    "^.+\\.(ts|js)$": ["ts-jest", { tsconfig: "tsconfig.json", isolatedModules: true }],
  },
  clearMocks: true,
  moduleNameMapper: {
    "^@tevalabs/xelma-bindings$": "<rootDir>/src/__mocks__/xelma-bindings.ts",
  },
};

// Unit tests - fast, no external dependencies
const unitConfig: JestConfig = {
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
const integrationConfig: JestConfig = {
  ...baseConfig,
  displayName: "integration",
  testMatch: [
    `**/{${integrationTestFiles.map((file) => file.replace(".spec.ts", "")).join(",")}}.spec.ts`,
  ],
  setupFiles: ["<rootDir>/jest.setup.js"],
};

const config: JestConfig = {
  ...baseConfig,
  testMatch: ["**/*.spec.ts"],
  setupFiles: ["<rootDir>/jest.setup.js"],
  projects: [unitConfig, integrationConfig],
  testTimeout: 30000,
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
  // Coverage floors, raised incrementally as under-covered modules gain
  // tests (see src/tests/{challenge,payout,response,timeout-wrapper}*
  // .spec.ts, added specifically to close gaps here). Lines/statements were
  // the weakest floor relative to branches/functions, since money-path
  // services had branch coverage from error-path tests but many pure
  // utility modules had none at all.
  //
  // Follow-up plan: once round-scheduler.service, resolution.service, and
  // the Soroban integration layer have direct unit tests (currently
  // exercised only indirectly via route specs), raise this again toward
  // lines/statements 50, functions 65, branches 75.
  coverageThreshold: {
    global: {
      branches: 71,
      functions: 51,
      lines: 38,
      statements: 38,
    },
  },
};

export default config;
