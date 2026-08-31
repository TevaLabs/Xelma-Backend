/**
 * Guard that runs BEFORE any other module loads (imported first in the entry
 * points) so unsupported Node.js versions fail fast with a clear message
 * instead of surfacing an unrelated config/import error first.
 *
 * Mirrors the minimum version declared in package.json "engines".
 */
const MIN_NODE_MAJOR = 22;

export function assertSupportedNodeVersion(): void {
  if (process.env.NODE_ENV === 'test') return;
  const raw = process.version;
  const major = parseInt(raw.replace('v', '').split('.')[0], 10);
  if (isNaN(major) || major < MIN_NODE_MAJOR) {
    process.stderr.write(
      `\nApplication startup failed: Node.js v${MIN_NODE_MAJOR}.x or higher is required ` +
        `(found ${raw}). Upgrade Node.js before starting the server.\n\n`,
    );
    process.exit(1);
  }
}

assertSupportedNodeVersion();