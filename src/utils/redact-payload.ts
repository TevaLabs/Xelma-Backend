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
