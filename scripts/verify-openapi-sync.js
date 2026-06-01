#!/usr/bin/env node
/**
 * Verifies that docs/openapi.json matches the generated spec from route annotations.
 * CI runs this after `npm run build` and `npm run docs:openapi`.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SPEC_PATH = path.join(ROOT, "docs", "openapi.json");

const REQUIRED_PATHS = [
  "/api/auth/challenge",
  "/api/auth/connect",
  "/api/predictions/submit",
  "/api/predictions/batch-submit",
  "/api/chat/send",
  "/api/admin/metrics/rate-limits",
  "/api/rounds/start",
];

function main() {
  if (!fs.existsSync(path.join(ROOT, "dist", "scripts", "generate-openapi.js"))) {
    console.error("Missing dist/scripts/generate-openapi.js — run `npm run build` first.");
    process.exit(1);
  }

  execSync("npm run docs:openapi", { cwd: ROOT, stdio: "inherit" });

  if (!fs.existsSync(SPEC_PATH)) {
    console.error(`OpenAPI spec was not written to ${SPEC_PATH}`);
    process.exit(1);
  }

  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"));
  const paths = spec.paths ?? {};
  const missing = REQUIRED_PATHS.filter((p) => !paths[p]);

  if (missing.length > 0) {
    console.error("Generated OpenAPI spec is missing required paths:");
    for (const p of missing) {
      console.error(`  - ${p}`);
    }
    process.exit(1);
  }

  console.log(`OpenAPI sync OK (${Object.keys(paths).length} paths, required routes present).`);
}

main();
