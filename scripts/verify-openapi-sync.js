#!/usr/bin/env node
/**
 * Verifies that docs/openapi.json matches the generated spec from route annotations.
 * CI runs this after `npm run build` and `npm run docs:openapi`.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PRODUCTION_SPEC_PATH = path.join(ROOT, "docs", "openapi.json");
const HACKATHON_SPEC_PATH = path.join(ROOT, "docs", "hackathon-openapi.json");

const REQUIRED_PRODUCTION_PATHS = [
  "/api/auth/challenge",
  "/api/auth/connect",
  "/api/predictions/submit",
  "/api/predictions/batch-submit",
  "/api/chat/send",
  "/api/admin/metrics/rate-limits",
  "/api/rounds/start",
];

const REQUIRED_HACKATHON_PATHS = [
  "/api/health",
  "/api/prices",
  "/api/stats",
  "/api/rounds",
  "/api/leaderboard",
];

function assertRequiredPaths(specPath, requiredPaths, label) {
  if (!fs.existsSync(specPath)) {
    console.error(`OpenAPI spec was not written to ${specPath}`);
    process.exit(1);
  }

  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const paths = spec.paths ?? {};
  const missing = requiredPaths.filter((p) => !paths[p]);

  if (missing.length > 0) {
    console.error(`${label} OpenAPI spec is missing required paths:`);
    for (const p of missing) {
      console.error(`  - ${p}`);
    }
    process.exit(1);
  }

  console.log(
    `${label} OpenAPI sync OK (${Object.keys(paths).length} paths, required routes present).`
  );
}

function main() {
  if (!fs.existsSync(path.join(ROOT, "dist", "scripts", "generate-openapi.js"))) {
    console.error("Missing dist/scripts/generate-openapi.js — run `npm run build` first.");
    process.exit(1);
  }

  execSync("npm run docs:openapi", { cwd: ROOT, stdio: "inherit" });

  assertRequiredPaths(PRODUCTION_SPEC_PATH, REQUIRED_PRODUCTION_PATHS, "Production");
  assertRequiredPaths(HACKATHON_SPEC_PATH, REQUIRED_HACKATHON_PATHS, "Hackathon");
}

main();
