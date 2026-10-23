#!/usr/bin/env node
/**
 * Production-readiness scorecard (#197, #282).
 *
 * Walks a set of "is this repo ready to run in production?" heuristics
 * that don't require running the app, and prints a green/red scorecard.
 * CI calls this; the exit code is non-zero only when a check marked
 * `required` fails, so the scorecard can ship soft "nice to have"
 * checks without blocking merges right away.
 *
 * Each check returns:
 *   { name, status: "pass" | "warn" | "fail", required: boolean, detail: string }
 *
 * New in #282: checks for tests configured, OpenAPI tooling, env example
 * completeness, and migration health.
 *
 * New in #632: three recurring production gaps are checked individually —
 *   - docs/architecture.md exists (file check),
 *   - the auth router registers a JWT refresh route (source heuristic),
 *   - GET /metrics sits behind an auth guard everywhere it is mounted
 *     (source heuristic).
 * The heuristics read route registrations with comments stripped, so a
 * stray mention of "refresh" or "auth" in a docblock cannot satisfy them.
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

const CRITICAL_ENV_VARS = [
  "DATABASE_URL",
  "JWT_SECRET",
  "PORT",
  "SOROBAN_CONTRACT_ID",
  "SOROBAN_RPC_URL",
];

// Collect all check-related helper functions after the checks array
// to avoid hoisting issues. New checks are added to the `checks` array.
const { statSync, readdirSync } = fs;

// Import drop risk scanner for migration safety check
const { scanSqlContent } = require("./scan-migration-drop-risk");

function migrationDirs() {
  const dir = path.join(ROOT, "prisma", "migrations");
  if (!fs.existsSync(dir)) return [];
  return readdirSync(dir)
    .map((e) => path.join(dir, e))
    .filter((p) => statSync(p).isDirectory())
    .sort();
}

function specFilesExist() {
  const testDir = path.join(ROOT, "src", "tests");
  if (!fs.existsSync(testDir)) return false;
  return readdirSync(testDir).some((f) => f.endsWith(".spec.ts"));
}

function missingEnvVars() {
  const env = readFileMaybe(".env.example");
  if (!env) return CRITICAL_ENV_VARS;
  return CRITICAL_ENV_VARS.filter(
    (v) => !new RegExp(`^${v}\\s*=`, "m").test(env),
  );
}

// ── Source heuristics (#632) ────────────────────────────────────────
// These inspect how routes are *registered*, not whether a word appears
// somewhere in the file, so comments are removed before matching.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** True when the auth router registers a handler on the `/refresh` path. */
function hasRefreshRoute(authRoutesSource) {
  if (!authRoutesSource) return false;
  return /\brouter\.(post|put|patch|get)\(\s*["'`]\/refresh["'`]\s*,/.test(
    stripComments(authRoutesSource),
  );
}

// Middleware names that count as explicit protection for /metrics: the
// repo's require*/authenticate* guards, or a token / API key / allowlist check.
const METRICS_GUARD_PATTERN =
  /\b(require[A-Z]\w*|authenticate\w*|verify\w*Token\w*|\w*[Aa]llow[Ll]ist\w*|\w*[Aa]pi[Kk]ey\w*)\b/;

/**
 * True when the metrics router's scrape handler (`router.get("/")`) has a
 * guard middleware in front of it AND every `/metrics` mount in the app
 * factory serves that router (so no unguarded inline handler shadows it).
 */
function metricsRouteIsProtected(metricsRoutesSource, appFactorySource) {
  if (!metricsRoutesSource || !appFactorySource) return false;

  const routes = stripComments(metricsRoutesSource);
  // Everything between the path and the handler's parameter list is the
  // middleware chain, e.g. `router.get("/", requirePublicMetricsAuth, async (`.
  const scrape = routes.match(
    /\brouter\.get\(\s*["'`]\/["'`]\s*,([\s\S]*?)(?:async\s*)?\(\s*_?req\b/,
  );
  if (!scrape || !METRICS_GUARD_PATTERN.test(scrape[1])) return false;

  const factory = stripComments(appFactorySource);
  const routerImport = factory.match(
    /import\s+(\w+)\s+from\s+["']\.\/routes\/metrics\.routes["']/,
  );
  if (!routerImport) return false;

  const mounts = [
    ...factory.matchAll(
      /\.(?:use|get|all)\(\s*["'`]\/metrics["'`]\s*,\s*([^)]*)\)/g,
    ),
  ];
  return (
    mounts.length > 0 &&
    mounts.every((mount) => mount[1].trim() === routerImport[1])
  );
}

const newChecks = [
  // ── Tests configured ──────────────────────────────────────────────
  {
    name: "Jest configuration is in place",
    required: true,
    run: () =>
      fileExists("jest.config.ts") || fileExists("jest.config.js"),
    detail:
      "Jest config (jest.config.ts or jest.config.js) is required. Without it, `npm test` cannot run the test suite.",
  },
  {
    name: "Test spec files exist in src/tests/",
    required: true,
    run: () => specFilesExist(),
    detail:
      "No .spec.ts files found in src/tests/. Add at least one test to establish the test suite and validate the Jest setup.",
  },

  // ── OpenAPI tooling ───────────────────────────────────────────────
  {
    name: "OpenAPI spec generation source exists",
    required: true,
    run: () => fileExists("src/scripts/generate-openapi.ts"),
    detail:
      "The OpenAPI generator at src/scripts/generate-openapi.ts is missing. It auto-documents all API routes from Express annotations.",
  },
  {
    name: "OpenAPI spec verification script exists",
    required: true,
    run: () => fileExists("scripts/verify-openapi-sync.js"),
    detail:
      "scripts/verify-openapi-sync.js checks that the generated openapi.json includes all required route paths. Create it or restore it from version control.",
  },
  {
    name: "Generated OpenAPI spec is committed",
    required: true,
    run: () => fileExists("docs/openapi.json"),
    detail:
      "docs/openapi.json is the committed API contract. Regenerate it with `npm run build && npm run docs:openapi` and commit the result.",
  },

  // ── .env.example completeness ─────────────────────────────────────
  {
    name: "Critical env vars are documented in .env.example",
    required: true,
    run: () => missingEnvVars().length === 0,
    detail: (() => {
      const missing = missingEnvVars();
      if (missing.length === 0) return "";
      return (
        `.env.example is missing required env vars: ${missing.join(", ")}. ` +
        "Add placeholder entries so operators know what configuration is needed."
      );
    })(),
  },

  // ── Migration health ──────────────────────────────────────────────
  {
    name: "Database migrations exist",
    required: true,
    run: () => migrationDirs().length > 0,
    detail:
      "No migrations found in prisma/migrations/. Run `npx prisma migrate dev --name init` to create the initial migration.",
  },
  {
    name: "Schema and migrations appear in sync (mtime check)",
    required: true,
    run: () => {
      const schema = path.join(ROOT, "prisma", "schema.prisma");
      if (!fs.existsSync(schema)) return false;
      const dirs = migrationDirs();
      if (dirs.length === 0) return false;
      const schemaMtime = statSync(schema).mtimeMs;
      const latestMtime = statSync(dirs[dirs.length - 1]).mtimeMs;
      return schemaMtime <= latestMtime + 1000; // 1s tolerance for filesystem skew
    },
    detail:
      "prisma/schema.prisma was modified more recently than the latest migration directory. Run `npx prisma migrate dev` to generate a migration for pending schema changes.",
  },
  {
    name: "Latest migration directory contains migration.sql",
    required: true,
    run: () => {
      const dirs = migrationDirs();
      if (dirs.length === 0) return false;
      return readdirSync(dirs[dirs.length - 1]).some((f) =>
        f.endsWith(".sql"),
      );
    },
    detail:
      "The most recent migration directory is missing migration.sql. It may be corrupt. Run `npx prisma migrate dev` to regenerate.",
  },
  {
    name: "Migrations are free of unapproved DROP risk",
    required: true,
    run: () => {
      const dirs = migrationDirs();
      for (const dir of dirs) {
        const sqlPath = path.join(dir, "migration.sql");
        if (fs.existsSync(sqlPath)) {
          const sql = fs.readFileSync(sqlPath, "utf8");
          if (scanSqlContent(sql).length > 0) {
            return false;
          }
        }
      }
      return true;
    },
    detail:
      "Destructive DROP operation (e.g. DROP TABLE/COLUMN) detected in prisma/migrations. Dropping tables or columns poses data loss risk. Annotate with `-- allow-drop: <reason>` if intentional.",
  },

  // ── Recurring production gaps (#632) ──────────────────────────────
  {
    name: "Architecture documentation exists (docs/architecture.md)",
    required: true,
    run: () => fileExists("docs/architecture.md"),
    detail:
      "docs/architecture.md is missing. Operators and new contributors need a written map of the runtime (entrypoints, layers, background jobs) before running this in production.",
  },
  {
    name: "Auth routes expose a JWT refresh endpoint",
    required: true,
    run: () => hasRefreshRoute(readFileMaybe("src/routes/auth.routes.ts")),
    detail:
      "No `router.post(\"/refresh\", ...)` registration found in src/routes/auth.routes.ts. Without a refresh route, clients must redo the full wallet-signature challenge every time a JWT expires.",
  },
  {
    name: "/metrics is protected by an auth guard",
    required: true,
    run: () =>
      metricsRouteIsProtected(
        readFileMaybe("src/routes/metrics.routes.ts"),
        readFileMaybe("src/app-factory.ts"),
      ),
    detail:
      "GET /metrics does not appear to be guarded. src/routes/metrics.routes.ts must register the scrape handler behind an auth middleware (e.g. requirePublicMetricsAuth), and every `/metrics` mount in src/app-factory.ts must serve that router. An open /metrics leaks route names, traffic volumes and process internals.",
  },
];

checks.push(...newChecks);

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

// Run when invoked as a script; export the pure heuristics so they can be
// unit tested against fixture source without touching the real repo files.
if (require.main === module) {
  main();
}

module.exports = { stripComments, hasRefreshRoute, metricsRouteIsProtected };
