/**
 * Credential redaction for request logging (Issue #886).
 *
 * Anything derived from an incoming request (headers, URL query strings) must
 * pass through these helpers before it reaches a log sink, so bearer tokens,
 * session cookies and API keys never appear in plain text. Every helper
 * returns a redacted copy and never mutates its input, so auth middleware
 * that runs after logging still sees the real credentials.
 */

export const REDACTED = '[REDACTED]';

/**
 * Header names (lower-case) whose values are always replaced.
 *
 * `authorization` carries user JWTs and the METRICS_SCRAPE_TOKEN; the rest are
 * standard or widely used credential headers that proxies and clients may
 * attach even though this API does not read them.
 */
export const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
  'x-refresh-token',
  'x-csrf-token',
  'x-xsrf-token',
]);

/**
 * Query parameter names whose values are replaced. Matching ignores case and
 * `-`/`_` separators, so `access_token`, `accessToken` and `Access-Token` are
 * all covered by `accesstoken`.
 */
export const SENSITIVE_QUERY_PARAMS: ReadonlySet<string> = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'jwt',
  'apikey',
  'key',
  'secret',
  'clientsecret',
  'password',
  'signature',
  'sig',
]);

// A credential scheme prefix in a header we don't otherwise know about
// (e.g. a custom `X-Upstream-Auth: Bearer ...`) is still a credential.
const CREDENTIAL_SCHEME = /^\s*(bearer|basic|digest|token)\s+\S/i;

type HeaderValue = string | string[] | number | undefined;

function normalizeParamName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, '');
}

function redactHeaderValue(value: HeaderValue, sensitive: boolean): HeaderValue {
  if (value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => (sensitive || CREDENTIAL_SCHEME.test(v) ? REDACTED : v));
  }
  if (sensitive) return REDACTED;
  return typeof value === 'string' && CREDENTIAL_SCHEME.test(value) ? REDACTED : value;
}

/**
 * Return a copy of `headers` with credential values replaced by `[REDACTED]`.
 *
 * Header names are matched case-insensitively and keys are kept, so the log
 * still shows that a credential was sent. Array values (e.g. multiple
 * `Set-Cookie` headers) are redacted element by element.
 */
export function sanitizeHeaders(
  headers: Record<string, HeaderValue> | undefined | null,
): Record<string, HeaderValue> {
  const out: Record<string, HeaderValue> = {};
  if (!headers) return out;

  for (const [name, value] of Object.entries(headers)) {
    out[name] = redactHeaderValue(value, SENSITIVE_HEADERS.has(name.toLowerCase()));
  }
  return out;
}

/**
 * Redact sensitive query parameter values in a request URL or path.
 *
 * The path and non-sensitive parameters are left byte-for-byte untouched so
 * the result stays readable; only the values of matching parameters are
 * replaced. A URL without a query string is returned as-is.
 */
export function redactUrl(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;

  const hashStart = url.indexOf('#', queryStart);
  const queryEnd = hashStart === -1 ? url.length : hashStart;
  const query = url.slice(queryStart + 1, queryEnd);

  const redacted = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const rawName = eq === -1 ? pair : pair.slice(0, eq);
      let name: string;
      try {
        name = decodeURIComponent(rawName.replace(/\+/g, ' '));
      } catch {
        name = rawName;
      }
      if (eq === -1 || !SENSITIVE_QUERY_PARAMS.has(normalizeParamName(name))) {
        return pair;
      }
      return `${rawName}=${REDACTED}`;
    })
    .join('&');

  return `${url.slice(0, queryStart + 1)}${redacted}${url.slice(queryEnd)}`;
}
