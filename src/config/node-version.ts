/**
 * Early Node.js version gate (startup).
 *
 * Imported as a side-effect from src/index.ts BEFORE any other module is
 * required, so a server started on an unsupported Node version fails fast
 * with a clear message instead of dying deep inside a dependency's require()
 * chain (e.g. the ERR_REQUIRE_ESM crash from @stellar/stellar-sdk on
 * Node 18, which previously masked the real cause).
 *
 * Skipped under NODE_ENV=test so test suites can import index.ts freely.
 * Mirrors MIN_NODE_MAJOR in src/config/preflight.ts and the `engines` field
 * in package.json.
 */
const MIN_NODE_MAJOR = 22;

if (process.env.NODE_ENV !== 'test') {
  const major = parseInt(process.version.replace('v', '').split('.')[0], 10);
  if (isNaN(major) || major < MIN_NODE_MAJOR) {
    console.error(
      `Application startup failed: Node.js v${MIN_NODE_MAJOR}.x or higher is required (running ${process.version}).`,
    );
    process.exit(1);
  }
}

export {};
