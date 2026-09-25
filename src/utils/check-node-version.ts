/**
 * Guard that runs BEFORE any other module loads (imported first in the entry
 * points) so unsupported Node.js versions fail fast with a clear message
 * instead of surfacing an unrelated config/import error first.
 *
 * Mirrors the minimum version declared in package.json "engines".
 */
import { getNodeVersionError } from '../config/preflight';

export function assertSupportedNodeVersion(): void {
  if (process.env.NODE_ENV === 'test') return;

  const raw = process.versions.node ?? process.version;
  const error = getNodeVersionError(raw);
  if (error) {
    process.stderr.write(`\nApplication startup failed: ${error}\n\n`);
    process.exit(1);
  }
}

assertSupportedNodeVersion();