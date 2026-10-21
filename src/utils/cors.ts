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

export const getHttpCorsOrigins = getCorsOrigins;

export interface SocketCorsConfig {
  origin: CorsOriginConfig;
  methods: string[];
  credentials: boolean;
}

export function getSocketCorsConfig(): SocketCorsConfig {
  return {
    origin: getCorsOrigins(),
    methods: ['GET', 'POST'],
    credentials: true,
  };
}
