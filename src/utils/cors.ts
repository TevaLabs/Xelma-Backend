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

/**
 * Determines whether CORS diagnostics endpoint is enabled.
 * Defaults to false (for debug/hackathon use only).
 */
export function isCorsDiagnosticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ENABLE_CORS_DIAGNOSTICS?.trim()?.toLowerCase();
  return raw === 'true' || raw === '1';
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

export const getHttpCorsOrigins = getCorsOrigins;
