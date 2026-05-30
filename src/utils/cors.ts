/**
 * Resolve the CORS origin allowlist for Express HTTP routes.
 * Mirrors the logic in socket.ts getCorsOrigins() so both layers
 * enforce the same policy.
 */
export function getHttpCorsOrigins(): string | string[] | boolean {
  const clientUrl = process.env.CLIENT_URL;
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    if (!clientUrl) {
      throw new Error(
        'CLIENT_URL environment variable is required in production. ' +
          'HTTP CORS cannot use wildcard origin (*) in production.',
      );
    }
    const additional = process.env.ALLOWED_ORIGINS;
    if (additional) {
      return [clientUrl, ...additional.split(',').map((o) => o.trim()).filter(Boolean)];
    }
    return clientUrl;
  }

  if (!clientUrl) {
    return true; // Allow all origins in development when CLIENT_URL is unset
  }

  const additional = process.env.ALLOWED_ORIGINS;
  if (additional) {
    return [clientUrl, ...additional.split(',').map((o) => o.trim()).filter(Boolean)];
  }
  return clientUrl;
}
