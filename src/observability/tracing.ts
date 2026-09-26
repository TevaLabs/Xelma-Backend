/**
 * Lightweight OpenTelemetry-style tracing (#534, #630).
 *
 * Request IDs already correlate logs, but nothing connected an HTTP request to
 * the Prisma work and the Soroban RPC call it triggered. When a bet fails,
 * support had to grep three streams. This module adds a tiny span helper —
 * deliberately dependency-free rather than pulling in the full OTel SDK — that
 * produces nested spans for one request:
 *
 *   http.server.request
 *     └─ bet.place.up-down
 *          └─ soroban.sorobanPlaceBet        (attributes: requestId, txHash)
 *
 * Design constraints:
 *   • Disabled by default. `OTEL_TRACING_ENABLED=true` (or setting
 *     `OTEL_EXPORTER_OTLP_ENDPOINT`) turns it on. When off, every helper is a
 *     near-zero-cost no-op, so tests and CI never need a collector.
 *   • `requestId` is attached to spans via the existing AsyncLocalStorage
 *     request context, so callers do not thread it through.
 *   • `txHash` is attached on Soroban spans when the contract call returns one.
 *   • Exports either to the console (default) or to an OTLP/HTTP endpoint via
 *     `OTEL_EXPORTER_OTLP_ENDPOINT` (fire-and-forget, failures swallowed).
 *
 * See docs/tracing.md for local enablement.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes } from 'crypto';
import logger from '../utils/logger';
import { getRequestId } from '../utils/requestContext';

export type SpanAttributeValue = string | number | boolean | null | undefined;
export type SpanAttributes = Record<string, SpanAttributeValue>;

export type SpanStatus = 'unset' | 'ok' | 'error';

/** Read-only projection handed to exporters. */
export interface ReadonlySpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly startTime: number;
  readonly endTime?: number;
  readonly status: SpanStatus;
  readonly attributes: Readonly<SpanAttributes>;
  /** Error message recorded via {@link Span.recordError}, when any. */
  readonly errorMessage?: string;
}

export interface Span extends ReadonlySpan {
  setAttribute(key: string, value: SpanAttributeValue): void;
  recordError(error: unknown): void;
  markOk(): void;
  end(): void;
}

export interface SpanExporter {
  exportSpan(span: ReadonlySpan): void;
}

const SERVICE_NAME = 'xelma-backend';

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** True when tracing should run for this environment. */
export function computeTracingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.OTEL_TRACING_ENABLED?.trim().toLowerCase();
  if (flag === 'false') return false;
  if (flag === 'true') return true;
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim());
}

class ConsoleSpanExporter implements SpanExporter {
  exportSpan(span: ReadonlySpan): void {
    logger.debug('trace span', {
      name: span.name,
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      durationMs: span.endTime !== undefined ? span.endTime - span.startTime : undefined,
      status: span.status,
      attributes: span.attributes,
      error: span.errorMessage,
    });
  }
}

function attributeToOtlp(key: string, value: SpanAttributeValue): Record<string, unknown> {
  if (typeof value === 'number') return { key, value: { doubleValue: value } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  return { key, value: { stringValue: value === null || value === undefined ? '' : String(value) } };
}

class OtlpHttpSpanExporter implements SpanExporter {
  private readonly tracesUrl: string;

  constructor(endpoint: string) {
    this.tracesUrl = `${endpoint.replace(/\/$/, '')}/v1/traces`;
  }

  exportSpan(span: ReadonlySpan): void {
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [attributeToOtlp('service.name', SERVICE_NAME)],
          },
          scopeSpans: [
            {
              scope: { name: SERVICE_NAME },
              spans: [
                {
                  traceId: span.traceId,
                  spanId: span.spanId,
                  parentSpanId: span.parentSpanId,
                  name: span.name,
                  kind: 1,
                  startTimeUnixNano: String(span.startTime * 1_000_000),
                  endTimeUnixNano: String((span.endTime ?? span.startTime) * 1_000_000),
                  attributes: Object.entries(span.attributes).map(([key, value]) =>
                    attributeToOtlp(key, value),
                  ),
                  status: { code: span.status === 'error' ? 2 : 1, message: span.errorMessage },
                },
              ],
            },
          ],
        },
      ],
    };

    // Fire-and-forget: tracing must never affect request latency or fail a
    // request just because a collector is unreachable.
    try {
      void fetch(this.tracesUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => undefined);
    } catch {
      /* ignore exporter failures */
    }
  }
}

export function createDefaultExporter(env: NodeJS.ProcessEnv = process.env): SpanExporter {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (endpoint) return new OtlpHttpSpanExporter(endpoint);
  return new ConsoleSpanExporter();
}

class RealSpan implements Span {
  public readonly traceId: string;
  public readonly spanId: string;
  public readonly parentSpanId?: string;
  public readonly startTime: number;
  public endTime?: number;
  public status: SpanStatus = 'unset';
  public errorMessage?: string;
  public readonly attributes: SpanAttributes;

  constructor(
    public readonly name: string,
    parent: Span | undefined,
    attributes: SpanAttributes,
  ) {
    this.traceId = parent?.traceId ?? randomHex(16);
    this.spanId = randomHex(8);
    this.parentSpanId = parent?.spanId;
    this.startTime = Date.now();
    this.attributes = { ...attributes };
  }

  setAttribute(key: string, value: SpanAttributeValue): void {
    this.attributes[key] = value;
  }

  recordError(error: unknown): void {
    this.status = 'error';
    this.errorMessage = error instanceof Error ? error.message : String(error);
    this.attributes['error'] = true;
    if (this.errorMessage) this.attributes['error.message'] = this.errorMessage;
  }

  markOk(): void {
    if (this.status === 'unset') this.status = 'ok';
  }

  end(): void {
    if (this.endTime === undefined) this.endTime = Date.now();
    if (this.status === 'unset') this.status = 'ok';
  }
}

class NoopSpan implements Span {
  public readonly traceId = '';
  public readonly spanId = '';
  public readonly parentSpanId?: string;
  public readonly startTime = 0;
  public readonly endTime?: number;
  public readonly status: SpanStatus = 'unset';
  public readonly attributes: SpanAttributes = {};
  public readonly errorMessage?: string;

  constructor(public readonly name = '') {}

  setAttribute(): void {}

  recordError(): void {}

  markOk(): void {}

  end(): void {}
}

interface TracingState {
  span: Span;
}

const storage = new AsyncLocalStorage<TracingState>();

let enabled: boolean = computeTracingEnabled();
let exporter: SpanExporter = createDefaultExporter();

/** Whether spans are currently recorded. Reflects the last configure/reset. */
export function isTracingEnabled(): boolean {
  return enabled;
}

/** Current active span, if tracing is on and a span is in scope. */
export function getActiveSpan(): Span | undefined {
  return storage.getStore()?.span;
}

/** Trace/span ids for log correlation. Empty when tracing is disabled. */
export function getTraceContext(): { traceId?: string; spanId?: string } {
  const span = getActiveSpan();
  if (!span || !span.traceId) return {};
  return { traceId: span.traceId, spanId: span.spanId };
}

/**
 * Create a span. Parenting defaults to the active span so nested calls
 * (`bet.place` → `soroban.place_bet`) form a tree automatically.
 */
export function startSpan(
  name: string,
  attributes: SpanAttributes = {},
  parent: Span | undefined = getActiveSpan(),
): Span {
  if (!enabled) return new NoopSpan(name);
  if (attributes.requestId === undefined) {
    const requestId = getRequestId();
    if (requestId) attributes = { ...attributes, requestId };
  }
  return new RealSpan(name, parent, attributes);
}

/**
 * Make `span` the active span for the remainder of the current async context.
 * Used by the HTTP middleware so every downstream service nests correctly.
 */
export function enterSpan(span: Span): void {
  if (!span.traceId) return; // noop span — tracing disabled
  storage.enterWith({ span });
}

/** End a span and hand it to the exporter exactly once. */
export function finishSpan(span: Span): void {
  if (!span.traceId) return; // noop span — nothing to export
  span.end();
  try {
    exporter.exportSpan(span);
  } catch {
    /* exporters must never break the caller */
  }
}

/**
 * Run `fn` inside a new child span. When tracing is disabled `fn` still runs
 * (with a no-op span) so call sites need no conditional logic.
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (span: Span) => T | Promise<T>,
): Promise<T> {
  if (!enabled) return fn(new NoopSpan(name));

  const span = startSpan(name, attributes);
  return storage.run({ span }, async () => {
    try {
      const result = await fn(span);
      span.markOk();
      return result;
    } catch (error) {
      span.recordError(error);
      throw error;
    } finally {
      finishSpan(span);
    }
  });
}

/**
 * Override tracing state. Primarily for tests (inject an in-memory exporter)
 * and for explicit programmatic setup.
 */
export function configureTracing(options: {
  enabled?: boolean;
  exporter?: SpanExporter;
}): void {
  if (options.enabled !== undefined) enabled = options.enabled;
  if (options.exporter !== undefined) exporter = options.exporter;
}

/** Restore env-derived defaults. Tests should call this in afterEach. */
export function resetTracing(env: NodeJS.ProcessEnv = process.env): void {
  enabled = computeTracingEnabled(env);
  exporter = createDefaultExporter(env);
}

export default {
  computeTracingEnabled,
  isTracingEnabled,
  getActiveSpan,
  getTraceContext,
  startSpan,
  enterSpan,
  finishSpan,
  withSpan,
  configureTracing,
  resetTracing,
};
