/**
 * Lightweight OpenTelemetry-style trace span utility (#534).
 *
 * Provides a minimal span API that correlates requestId across HTTP,
 * Prisma/DB, and Soroban calls.  Designed as a drop-in that can later be
 * swapped for the real OTel SDK without changing instrumentation call sites.
 *
 * Enable/disable:
 *   TRACE_ENABLED=false  → all span functions become no-ops (default in tests)
 *   TRACE_ENABLED=true   → spans are created and emitted to the configured exporter
 *   TRACE_EXPORT=console → spans logged to stdout (default for local dev)
 *   TRACE_EXPORT=none    → spans silently discarded
 *
 * Call sites are instrumented with `traceSpan()` and `traceSubSpan()`:
 *
 *   const result = await traceSpan('soroban.placeBet', { requestId, side }, async (span) => {
 *     // ... do work ...
 *     span.setAttribute('txHash', txHash);
 *     return result;
 *   });
 */

import logger from './logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpanAttributes {
  [key: string]: string | number | boolean;
}

export interface TraceSpan {
  /** Unique span identifier (hex). */
  spanId: string;
  /** Parent span ID, if nested. */
  parentSpanId?: string;
  /** Correlated request ID from Express middleware. */
  requestId?: string;
  /** Human-readable operation name (e.g. "soroban.placeBet"). */
  name: string;
  /** Monotonic start time in ms. */
  startMs: number;
  /** Attributes set during the span. */
  attributes: SpanAttributes;

  /** Attach an attribute to this span. */
  setAttribute(key: string, value: string | number | boolean): void;
  /** Record an error on this span. */
  recordError(error: Error): void;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function isEnabled(): boolean {
  const v = process.env.TRACE_ENABLED?.trim().toLowerCase();
  if (v === 'false') return false;
  if (v === 'true') return true;
  // Default: enabled unless NODE_ENV is test
  return process.env.NODE_ENV !== 'test';
}

function exportTarget(): 'console' | 'none' {
  const v = process.env.TRACE_EXPORT?.trim().toLowerCase();
  if (v === 'none') return 'none';
  return 'console';
}

// ---------------------------------------------------------------------------
// Span ID generator
// ---------------------------------------------------------------------------

let spanCounter = 0;

function generateSpanId(): string {
  spanCounter += 1;
  const timePart = Date.now().toString(16).padStart(12, '0');
  const counterPart = (spanCounter & 0xffffff).toString(16).padStart(6, '0');
  return (timePart + counterPart).slice(-16);
}

// ---------------------------------------------------------------------------
// Global context (async-local substitute)
//
// In production, OpenTelemetry uses AsyncLocalStorage.  For this lightweight
// implementation we keep a module-level current span that is set/cleared
// around `traceSpan` calls.  This is sufficient for sequential async flows
// (the common case in Express handlers).
// ---------------------------------------------------------------------------

let currentSpan: TraceSpan | null = null;

/** Return the currently-active span, if any. */
export function getCurrentSpan(): TraceSpan | null {
  return currentSpan;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportSpan(span: TraceSpan, durationMs: number, error?: Error): void {
  if (exportTarget() === 'none') return;

  const record: Record<string, unknown> = {
    traceId: span.requestId ?? 'no-request',
    spanId: span.spanId,
    parentSpanId: span.parentSpanId ?? null,
    name: span.name,
    startMs: span.startMs,
    durationMs,
    attributes: span.attributes,
  };

  if (error) {
    record.error = {
      name: error.name,
      message: error.message,
    };
  }

  logger.debug('[trace]', record);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute `fn` inside a named trace span.  The span is exported on
 * completion (success or failure).
 *
 * ```ts
 * const result = await traceSpan('http.GET /api/price', { requestId }, async (span) => {
 *   span.setAttribute('route', '/api/price');
 *   return priceService.get();
 * });
 * ```
 */
export async function traceSpan<T>(
  name: string,
  attributes: SpanAttributes = {},
  fn: (span: TraceSpan) => Promise<T> | T,
): Promise<T> {
  if (!isEnabled()) return fn(createNoopSpan(name));

  const span: TraceSpan = {
    spanId: generateSpanId(),
    parentSpanId: currentSpan?.spanId,
    requestId: attributes.requestId as string | undefined,
    name,
    startMs: Date.now(),
    attributes: { ...attributes },
    setAttribute(key, value) {
      this.attributes[key] = value;
    },
    recordError(error) {
      this.attributes['error.name'] = error.name;
      this.attributes['error.message'] = error.message;
    },
  };

  const prevSpan = currentSpan;
  currentSpan = span;
  const startMs = Date.now();

  try {
    const result = await fn(span);
    exportSpan(span, Date.now() - startMs);
    return result;
  } catch (error) {
    span.recordError(error as Error);
    exportSpan(span, Date.now() - startMs, error as Error);
    throw error;
  } finally {
    currentSpan = prevSpan;
  }
}

/**
 * Create a sub-span within the current active span.
 * Useful for instrumenting nested calls (e.g. DB query inside an HTTP handler).
 */
export async function traceSubSpan<T>(
  name: string,
  attributes: SpanAttributes = {},
  fn: (span: TraceSpan) => Promise<T> | T,
): Promise<T> {
  const mergedAttrs: SpanAttributes = {
    requestId: currentSpan?.requestId,
    ...attributes,
  };
  return traceSpan(name, mergedAttrs, fn);
}

// ---------------------------------------------------------------------------
// Noop span (used when tracing is disabled)
// ---------------------------------------------------------------------------

function createNoopSpan(name: string): TraceSpan {
  return {
    spanId: 'noop',
    name,
    startMs: 0,
    attributes: {},
    setAttribute() {},
    recordError() {},
  };
}
