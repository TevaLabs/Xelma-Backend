#!/usr/bin/env node
/**
 * Production-readiness scorecard (#197).
 *
 * Walks a small set of "is this repo ready to run in production?"
 * heuristics that don't require running the app, and prints a green/red
 * scorecard. CI calls this; the exit code is non-zero only when a check
 * marked `required` fails, so the scorecard can ship soft "nice to have"
 * checks without blocking merges right away.
 *
 * Each check returns:
 *   { name, status: "pass" | "warn" | "fail", required: boolean, detail: string }
 *
 * Why this lives as a plain Node script:
 *   - It runs before the TypeScript build, so it can flag a missing
 *     build artifact instead of crashing the CI step that needs it.
 *   - No extra deps; uses only the Node standard library so it is
 *     trivially auditable.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const pkgPath = path.join(ROOT, "package.json");
const pkg = fs.existsSync(pkgPath)
  ? JSON.parse(fs.readFileSync(pkgPath, "utf8"))
  : {};

function fileExists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

function packageHas(field, value) {
  return Boolean(pkg?.[field]?.[value]);
}

function readFileMaybe(relPath) {
  try {
    return fs.readFileSync(path.join(ROOT, relPath), "utf8");
  } catch {
    return null;
  }
}

const checks = [
  {
    name: "package.json declares a `start` script",
    required: true,
    run: () => packageHas("scripts", "start"),
    detail:
      "Production deploys run `npm start`. Without it, the build artifact has no documented entrypoint.",
  },
  {
    name: "package.json declares a `build` script",
    required: true,
    run: () => packageHas("scripts", "build"),
    detail: "CI builds via `npm run build` before deploy.",
  },
  {
    name: "package.json declares a `lint` script",
    required: true,
    run: () => packageHas("scripts", "lint"),
    detail: "Type-only lint (tsc --noEmit) protects deploys from regressing types.",
  },
  {
    name: "package.json declares a `test` script",
    required: true,
    run: () => packageHas("scripts", "test"),
    detail: "Required so CI can gate merges on the test suite.",
  },
  {
    name: ".env.example exists",
    required: true,
    run: () => fileExists(".env.example"),
    detail:
      "Operators copy `.env.example` to `.env`. A missing example invites copy-paste secrets from teammate chat.",
  },
  {
    name: "Prisma schema is present and committed",
    required: true,
    run: () => fileExists("prisma/schema.prisma"),
    detail: "Schema is the single source of truth for the database.",
  },
  {
    name: "CI workflow exists",
    required: true,
    run: () => fileExists(".github/workflows/ci.yml"),
    detail: "No CI = no gate. Merges should be blocked on green CI.",
  },
  {
    name: "Deploy workflow exists",
    required: false,
    run: () => fileExists(".github/workflows/deploy.yml"),
    detail:
      "A separate deploy workflow keeps CI fast and prevents accidental side effects in non-deploy runs.",
  },
  {
    name: "README documents the health endpoint",
    required: false,
    run: () => {
      const readme = readFileMaybe("README.md");
      return readme ? /\/health/.test(readme) : false;
    },
    detail:
      "Document `/health` so platform health checks (Render, k8s probes, ELB) can be wired without source diving.",
  },
  {
    name: "Vendored bindings install script is checked in",
    required: false,
    run: () => fileExists("scripts/install-bindings.js"),
    detail:
      "Production builds rely on vendor/xelma-bindings. The install script makes that reproducible.",
  },
  {
    name: "JWT_SECRET is referenced in .env.example (not hard-coded)",
    required: true,
    run: () => {
      const env = readFileMaybe(".env.example");
      return env ? /JWT_SECRET\s*=/.test(env) : false;
    },
    detail:
      "Server fails fast without JWT_SECRET; an example placeholder makes that obvious during onboarding.",
  },
];

function statusFor(result) {
  if (result.passed) return "pass";
  return result.required ? "fail" : "warn";
}

function render(rows) {
  const colorize = process.stdout.isTTY;
  const paint = (s, code) => (colorize ? `[${code}m${s}[0m` : s);
  const badges = {
    pass: paint("PASS", "32"),
    warn: paint("WARN", "33"),
    fail: paint("FAIL", "31"),
  };
  for (const row of rows) {
    const tag = row.required ? " [required]" : "";
    console.log(`  ${badges[row.status]}  ${row.name}${tag}`);
    if (row.status !== "pass") {
      console.log(`         ${row.detail}`);
    }
  }
}

function main() {
  console.log("Production-readiness scorecard");
  console.log("==============================");

  const results = checks.map((check) => {
    const passed = Boolean(check.run());
    return {
      name: check.name,
      required: check.required,
      detail: check.detail,
      passed,
      status: statusFor({ passed, required: check.required }),
    };
  });

  render(results);

  const failures = results.filter((r) => r.status === "fail");
  const warnings = results.filter((r) => r.status === "warn");
  const passes = results.filter((r) => r.status === "pass");

  console.log("");
  console.log(
    `Summary: ${passes.length} passing, ${warnings.length} warnings, ${failures.length} failing required checks.`,
  );

  if (failures.length > 0) {
    console.error("");
    console.error("Required production-readiness checks failed.");
    process.exit(1);
  }
}

main();
