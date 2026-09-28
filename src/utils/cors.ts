import logger from './logger';

export type CorsOriginConfig = string | string[] | boolean;

export function parseOriginList(raw: string | undefined | null): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function getCorsOrigins(): CorsOriginConfig {
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
    return true;
  }

  if (additional.length > 0) {
    return [clientUrl, ...additional];
  }

  return clientUrl;
}

/**
 * Returns whether `credentials: true` is safe for the current CORS origin
 * configuration.
 *
 * Browsers reject the combination of `Access-Control-Allow-Origin: *` and
 * `Access-Control-Allow-Credentials: true` (WHATWG Fetch / CORS spec).
 * When the resolved origin config is the wildcard (`true` / `"*"`),
 * credentials must be disabled to avoid a non-functional and misleading
 * configuration.
 *
 * - Explicit origin list (string or string[]) → credentials enabled (`true`).
 * - Wildcard / allow-all (`true` or `"*"`) → credentials disabled (`false`).
 */
export function corsCredentials(origins: CorsOriginConfig): boolean {
  if (origins === true || origins === '*') {
    return false;
  }
  return true;
}

export const getHttpCorsOrigins = getCorsOrigins;
