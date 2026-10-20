import logger from './logger';

export type CorsOriginConfig = boolean | string | Array<string | RegExp>;

export interface DescribedCorsConfig {
  allowAll: boolean;
  origins: string[];
}

/**
 * A compiled `https://*.example.com` rule. Subclasses RegExp so the `cors`
 * package and Socket.IO keep using their existing RegExp allowlist path.
 * `pattern` is the original configured string, for diagnostics.
 */
export class WildcardOrigin extends RegExp {
  readonly pattern: string;

  constructor(pattern: string, source: string) {
    super(source, 'i');
    this.pattern = pattern;
  }
}

interface ResolvedOrigin {
  pattern: string;
  match: string | WildcardOrigin;
}

interface ResolvedCors {
  allowAll: boolean;
  entries: ResolvedOrigin[];
}

const WILDCARD_ORIGIN =
  /^(https?):\/\/\*\.([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::(\d{1,5}))?$/i;

export function parseOriginList(raw: string | undefined | null): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isDnsLabel(label: string): boolean {
  return (
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)
  );
}

/**
 * Compile one configured origin. Exact origins pass through. A wildcard is
 * accepted only as a single leading host label (`https://*.example.com`),
 * which matches one subdomain and not the apex, nested names, or lookalike
 * suffixes. Bare `*`, `https://*`, and single-label suffixes such as
 * `https://*.com` are rejected.
 */
export function compileOrigin(pattern: string): string | WildcardOrigin {
  if (!pattern.includes('*')) {
    return pattern;
  }

  const match = WILDCARD_ORIGIN.exec(pattern);
  if (!match) {
    throw new Error(
      `Invalid CORS origin "${pattern}". Use an exact origin or a single-label wildcard such as https://*.example.com.`,
    );
  }

  const scheme = match[1].toLowerCase();
  const host = match[2].toLowerCase();
  const port = match[3];
  if (port !== undefined) {
    const portNumber = Number(port);
    if (portNumber < 1 || portNumber > 65535) {
      throw new Error(`Invalid CORS origin "${pattern}". Port must be between 1 and 65535.`);
    }
  }

  const labels = host.split('.');
  if (labels.length < 2 || labels.some((label) => !isDnsLabel(label))) {
    throw new Error(
      `Invalid CORS origin "${pattern}". Wildcard origins must name a registrable domain such as *.example.com.`,
    );
  }

  const escapedHost = host.replace(/\./g, '\\.');
  const portPart = port ? `:${port}` : '';
  const source = `^${scheme}://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.${escapedHost}${portPart}$`;
  return new WildcardOrigin(pattern, source);
}

function resolveCors(): ResolvedCors {
  const clientUrl = process.env.CLIENT_URL;
  const isProduction = process.env.NODE_ENV === 'production';
  const additional = parseOriginList(process.env.ALLOWED_ORIGINS);

  if (!clientUrl) {
    if (isProduction) {
      throw new Error(
        'CLIENT_URL environment variable is required in production. ' +
          'CORS cannot use a wildcard origin (*) with credentials enabled.',
      );
    }
    logger.warn(
      'CLIENT_URL not set; allowing all origins for development. ' +
        'Set CLIENT_URL to restrict origins.',
    );
    return { allowAll: true, entries: [] };
  }

  const patterns = [clientUrl, ...additional];
  return {
    allowAll: false,
    entries: patterns.map((pattern) => ({
      pattern,
      match: compileOrigin(pattern),
    })),
  };
}

export function describeCorsConfig(): DescribedCorsConfig {
  const resolved = resolveCors();
  return {
    allowAll: resolved.allowAll,
    origins: resolved.entries.map((entry) => entry.pattern),
  };
}

export function isOriginAllowed(origin: string): boolean {
  const resolved = resolveCors();
  if (resolved.allowAll) {
    return true;
  }
  return resolved.entries.some((entry) =>
    typeof entry.match === 'string' ? entry.match === origin : entry.match.test(origin),
  );
}

export function getCorsOrigins(): CorsOriginConfig {
  const resolved = resolveCors();
  if (resolved.allowAll) {
    return true;
  }

  const matches = resolved.entries.map((entry) => entry.match);
  if (matches.length === 1 && typeof matches[0] === 'string') {
    return matches[0];
  }
  return matches;
}

export const getHttpCorsOrigins = getCorsOrigins;
