/**
 * Redact secrets and PII from DLQ payload previews (Issue #430).
 */

const SENSITIVE_KEY = /^(password|secret|token|authorization|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|jwt|bearer|email|ssn|phone)$/i;

const PARTIAL_REDACT_KEY = /^(walletaddress|wallet[_-]?address|address)$/i;

function redactScalar(value: unknown, key?: string): unknown {
  if (value == null) return value;
  if (typeof value === "string" && /Bearer\s+\S+/i.test(value)) {
    return "Bearer [REDACTED]";
  }
  if (key && SENSITIVE_KEY.test(key)) {
    return "[REDACTED]";
  }
  if (key && PARTIAL_REDACT_KEY.test(key) && typeof value === "string") {
    if (value.length <= 8) return "[REDACTED]";
    return `${value.slice(0, 4)}…${value.slice(-4)}`;
  }
  return value;
}

export function redactDlqPayload(payload: unknown): unknown {
  if (payload == null || typeof payload !== "object") {
    return redactScalar(payload);
  }
  if (Array.isArray(payload)) {
    return payload.map(item => redactDlqPayload(item));
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (value != null && typeof value === "object") {
      out[key] = redactDlqPayload(value);
    } else {
      out[key] = redactScalar(value, key);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Size capping (Issue #707)
// ---------------------------------------------------------------------------

/**
 * Hard cap on the serialized size of a stored DLQ payload. A poison message
 * with a multi-megabyte body must not be able to bloat Postgres or the admin
 * replay view. 16 KiB is generous for real notification/websocket payloads.
 */
export const MAX_DLQ_PAYLOAD_BYTES = 16 * 1024;

export interface SanitizedDlqPayload {
  /** Redacted and, when oversized, truncated payload safe to persist. */
  payload: unknown;
  /** True when the original payload exceeded {@link MAX_DLQ_PAYLOAD_BYTES}. */
  truncated: boolean;
  /** Serialized byte length of the redacted-but-not-yet-truncated payload. */
  originalBytes: number;
}

/**
 * Marks a stored payload as truncated. Lets API consumers (and the admin list)
 * distinguish a real `truncated` business field from the cap sentinel by
 * checking the sibling `originalBytes`/`preview` keys.
 */
export function isTruncatedDlqPayload(payload: unknown): boolean {
  return (
    payload != null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).truncated === true
  );
}

/**
 * Redact secrets from a payload and cap its serialized size before it is
 * written to the DLQ.
 *
 * Order matters: redaction runs first so a truncated preview can never expose
 * an API key or bearer token that happened to sit beyond the cutoff.
 */
export function sanitizeDlqPayload(payload: unknown): SanitizedDlqPayload {
  const redacted = redactDlqPayload(payload ?? {});

  let json: string;
  try {
    json = JSON.stringify(redacted) ?? "null";
  } catch {
    json = JSON.stringify({ unserializable: true });
  }

  const originalBytes = Buffer.byteLength(json, "utf8");
  if (originalBytes <= MAX_DLQ_PAYLOAD_BYTES) {
    return { payload: redacted, truncated: false, originalBytes };
  }

  // Binary-search the largest preview byte length whose JSON-escaped form
  // still fits inside the cap. Escaping (quotes/backslashes) can expand the
  // preview, so a fixed slice is not sufficient.
  const jsonBytes = Buffer.from(json, "utf8");
  const buildPayload = (byteLength: number) => {
    const preview = jsonBytes
      .subarray(0, byteLength)
      .toString("utf8")
      // Drop a possibly-split multi-byte character at the cutoff.
      .replace(/\uFFFD+$/g, "");
    return { truncated: true as const, originalBytes, maxBytes: MAX_DLQ_PAYLOAD_BYTES, preview };
  };
  const sizeOf = (byteLength: number): number =>
    Buffer.byteLength(JSON.stringify(buildPayload(byteLength)), "utf8");

  let lo = 0;
  let hi = jsonBytes.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sizeOf(mid) <= MAX_DLQ_PAYLOAD_BYTES) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return {
    payload: buildPayload(best),
    truncated: true,
    originalBytes,
  };
}
