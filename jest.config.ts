import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.spec.ts"],
  testPathIgnorePatterns: [
    "/node_modules/",
    "rounds.routes.spec.ts",
    "predictions.routes.spec.ts",
    "round.spec.ts",
    "concurrent-rounds.spec.ts",
    "education-tip.route.spec.ts"
  ],
  moduleFileExtensions: ["ts", "js", "json"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json" }],
  },
  setupFiles: ["<rootDir>/jest.setup.js"],
  clearMocks: true,
};

export default config;
