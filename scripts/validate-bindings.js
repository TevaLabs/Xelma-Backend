#!/usr/bin/env node
/**
 * CI script to validate vendored @tevalabs/xelma-bindings against pinned metadata.
 *
 * Exits with code 1 if any of the following are true:
 *   - Structural files are missing (dist, package.json)
 *   - Commit SHA does not match .bindings-metadata.json
 *   - Required Client methods or module exports are missing
 *
 * Usage:
 *   node scripts/validate-bindings.js
 *
 * Environment variables:
 *   FAIL_ON_BINDINGS_MISMATCH — if "true", exit 1 on version skew (default in CI)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");
const VENDOR = path.join(ROOT, "vendor", "xelma-bindings");
const META_PATH = path.join(ROOT, ".bindings-metadata.json");
const COMMIT_SHA_PATH = path.join(VENDOR, ".commit-sha");
const ESM_ENTRY = path.join(VENDOR, "dist", "index.js");
const CJS_ENTRY = join(VENDOR, "dist", "cjs", "index.js");
const PKG_JSON = join(VENDOR, "package.json");

function join(...parts) {
  return path.join(...parts);
}

function fail(msg) {
  console.error(`[bindings-validator] FAIL: ${msg}`);
  return 1;
}

function warn(msg) {
  console.warn(`[bindings-validator] WARN: ${msg}`);
}

function info(msg) {
  console.log(`[bindings-validator] OK: ${msg}`);
}

let exitCode = 0;

// --- Structural checks ---------------------------------------------------

if (!fs.existsSync(VENDOR)) {
  exitCode = fail(
    "vendor/xelma-bindings missing. Run `npm run install-bindings`."
  );
} else {
  if (!fs.existsSync(ESM_ENTRY)) {
    exitCode = fail(`ESM entry missing: ${ESM_ENTRY}`);
  }
  if (!fs.existsSync(CJS_ENTRY)) {
    exitCode = fail(`CJS entry missing: ${CJS_ENTRY}`);
  }
  if (!fs.existsSync(PKG_JSON)) {
    exitCode = fail(`package.json missing: ${PKG_JSON}`);
  } else {
    try {
      const pkg = JSON.parse(fs.readFileSync(PKG_JSON, "utf8"));
      if (pkg.name !== "@tevalabs/xelma-bindings") {
        exitCode = fail(
          `package.json name is ${JSON.stringify(pkg.name)}, expected @tevalabs/xelma-bindings`
        );
      } else {
        info("package.json name is correct");
      }
    } catch (e) {
      exitCode = fail(`package.json is not valid JSON: ${e.message}`);
    }
  }
}

// --- Metadata / SHA pin checks -------------------------------------------

if (!fs.existsSync(META_PATH)) {
  warn(".bindings-metadata.json not found — skipping SHA and surface checks");
  process.exit(exitCode);
}

let meta;
try {
  meta = JSON.parse(fs.readFileSync(META_PATH, "utf8"));
} catch (e) {
  exitCode = fail(`.bindings-metadata.json is not valid JSON: ${e.message}`);
  process.exit(exitCode);
}

const expectedSha = meta.expectedCommitSha;
let vendorSha = null;
if (fs.existsSync(COMMIT_SHA_PATH)) {
  try {
    vendorSha = fs.readFileSync(COMMIT_SHA_PATH, "utf8").trim() || null;
  } catch {
    vendorSha = null;
  }
}

if (expectedSha && expectedSha !== "PLACEHOLDER") {
  if (!vendorSha) {
    exitCode = fail(
      `Vendor .commit-sha is missing but metadata pins expected SHA ${expectedSha}. ` +
        "Run `npm run install-bindings`."
    );
  } else if (vendorSha !== expectedSha) {
    exitCode = fail(
      `Vendor commit SHA ${vendorSha} does not match expected ${expectedSha}. ` +
        "The vendored bindings are stale. Run `npm run install-bindings`."
    );
  } else {
    info(`Vendor commit SHA matches expected: ${vendorSha}`);
  }
} else {
  warn("No pinned commit SHA in metadata (PLACEHOLDER) — skipping SHA check");
}

// --- API surface checks --------------------------------------------------

if (exitCode !== 0) {
  // Don't attempt surface checks if structural checks failed
  process.exit(exitCode);
}

const requiredMethods = meta.requiredClientMethods || [];
const requiredExports = meta.requiredExports || [];

if (requiredMethods.length === 0 && requiredExports.length === 0) {
  info("No required methods/exports defined in metadata — skipping surface checks");
  process.exit(0);
}

// Dynamic import for ESM module (use file:// URL for Windows compatibility)
(async () => {
  try {
    const { pathToFileURL } = require("url");
    const mod = await import(pathToFileURL(ESM_ENTRY).href);

    // Check required exports
    const missingExports = requiredExports.filter((name) => !(name in mod));
    if (missingExports.length > 0) {
      exitCode = fail(
        `Bindings module is missing required exports: ${missingExports.join(", ")}`
      );
    } else {
      info(`All ${requiredExports.length} required exports present`);
    }

    // Check required Client methods
    if (requiredMethods.length > 0) {
      const ClientClass = mod.Client;
      if (!ClientClass) {
        exitCode = fail("Client class not found in bindings module");
      } else {
        const proto = ClientClass.prototype;
        const missingMethods = requiredMethods.filter(
          (m) => typeof proto[m] !== "function"
        );
        if (missingMethods.length > 0) {
          exitCode = fail(
            `Client class is missing required methods: ${missingMethods.join(", ")}`
          );
        } else {
          info(`All ${requiredMethods.length} required Client methods present`);
        }
      }
    }
  } catch (e) {
    exitCode = fail(`Failed to import bindings module: ${e.message}`);
  }

  if (exitCode === 0) {
    info("Bindings validation passed all checks");
  }

  process.exit(exitCode);
})();
