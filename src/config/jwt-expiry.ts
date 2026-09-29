import type { StringValue } from 'ms';

export type JwtExpiry = StringValue | number;

function isJwtTimespan(value: string): value is StringValue {
  const match = value.match(
    /^(\d+(?:\.\d+)?)(?: )?(?:years?|yrs?|yr|y|weeks?|w|days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s|milliseconds?|msecs?|msec|ms)$/i,
  );

  return match !== null && Number.isFinite(Number(match[1])) && Number(match[1]) > 0;
}

export function parseJwtExpiry(value: string | undefined): JwtExpiry {
  const raw = value?.trim();
  if (!raw) return '7d';

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (Number.isSafeInteger(seconds) && seconds > 0) return seconds;
  }

  if (isJwtTimespan(raw)) return raw;

  throw new Error(
    `JWT_EXPIRY must be a positive integer number of seconds or a duration string such as "7d". Received "${raw}".`,
  );
}