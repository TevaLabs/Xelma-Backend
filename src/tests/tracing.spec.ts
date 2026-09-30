/**
 * Unit tests for the lightweight span helper (#534, #630).
 *
 * These run fully offline — no collector, no network. An in-memory exporter is
 * injected so we can assert span shape, nesting and attributes. Tracing is off
 * by default, which is also asserted here (CI must stay green without OTel).
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

import {
  ReadonlySpan,
  SpanExporter,
  computeTracingEnabled,
  configureTracing,
  enterSpan,
  finishSpan,
  getActiveSpan,
  getTraceContext,
  isTracingEnabled,
  resetTracing,
  startSpan,
  withSpan,
} from "../observability/tracing";
import { runWithRequestId } from "../utils/requestContext";

class MemoryExporter implements SpanExporter {
  public spans: ReadonlySpan[] = [];

  exportSpan(span: ReadonlySpan): void {
    this.spans.push(span);
  }
}

describe("tracing (#630)", () => {
  let exporter: MemoryExporter;

  beforeEach(() => {
    exporter = new MemoryExporter();
    configureTracing({ enabled: false, exporter });
  });

  afterEach(() => {
    resetTracing();
    delete process.env.OTEL_TRACING_ENABLED;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  describe("enablement", () => {
    it("is disabled by default", () => {
      resetTracing({});
      expect(isTracingEnabled()).toBe(false);
      expect(computeTracingEnabled({})).toBe(false);
    });

    it("enables via OTEL_TRACING_ENABLED=true", () => {
      expect(computeTracingEnabled({ OTEL_TRACING_ENABLED: "true" })).toBe(true);
    });

    it("enables when OTEL_EXPORTER_OTLP_ENDPOINT is set", () => {
      expect(
        computeTracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" }),
      ).toBe(true);
    });

    it("OTEL_TRACING_ENABLED=false wins over an endpoint", () => {
      expect(
        computeTracingEnabled({
          OTEL_TRACING_ENABLED: "false",
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
        }),
      ).toBe(false);
    });
  });

  describe("disabled by default", () => {
    it("still runs the callback and returns its value", async () => {
      const value = await withSpan("noop", { a: 1 }, () => 7);
      expect(value).toBe(7);
    });

    it("exports nothing and keeps no active span", async () => {
      await withSpan("noop", {}, async () => undefined);
      expect(exporter.spans).toHaveLength(0);
      expect(getActiveSpan()).toBeUndefined();
      expect(getTraceContext()).toEqual({});
    });
  });

  describe("enabled", () => {
    it("records a span with attributes, timing and ok status", async () => {
      configureTracing({ enabled: true });

      const value = await withSpan("bet.place", { "bet.amount": 10 }, async (span) => {
        span.setAttribute("extra", "yes");
        return 42;
      });

      expect(value).toBe(42);
      expect(exporter.spans).toHaveLength(1);

      const span = exporter.spans[0];
      expect(span.name).toBe("bet.place");
      expect(span.status).toBe("ok");
      expect(span.attributes["bet.amount"]).toBe(10);
      expect(span.attributes.extra).toBe("yes");
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(span.endTime).toBeGreaterThanOrEqual(span.startTime);
    });

    it("nests child spans under the active span, sharing one traceId", async () => {
      configureTracing({ enabled: true });

      await withSpan("http.server.request", {}, async () => {
        await withSpan("bet.place.up-down", {}, async () => {
          await withSpan("soroban.sorobanPlaceBet", { "soroban.tx_hash": "abc" }, async () => undefined);
        });
      });

      expect(exporter.spans).toHaveLength(3);
      // Spans are exported as they end, so the innermost finishes first.
      const root = exporter.spans.find((s) => s.name === "http.server.request")!;
      const bet = exporter.spans.find((s) => s.name === "bet.place.up-down")!;
      const soroban = exporter.spans.find((s) => s.name === "soroban.sorobanPlaceBet")!;

      expect(bet.parentSpanId).toBe(root.spanId);
      expect(soroban.parentSpanId).toBe(bet.spanId);
      expect(soroban.attributes["soroban.tx_hash"]).toBe("abc");
      // All three belong to the same trace.
      expect(new Set(exporter.spans.map((s) => s.traceId)).size).toBe(1);
    });

    it("records errors and rethrows", async () => {
      configureTracing({ enabled: true });

      await expect(
        withSpan("soroban.sorobanPlaceBet", {}, async () => {
          throw new Error("rpc unavailable");
        }),
      ).rejects.toThrow("rpc unavailable");

      expect(exporter.spans).toHaveLength(1);
      const span = exporter.spans[0];
      expect(span.status).toBe("error");
      expect(span.attributes.error).toBe(true);
      expect(span.errorMessage).toBe("rpc unavailable");
    });

    it("attaches requestId from the request context without threading it", async () => {
      configureTracing({ enabled: true });

      await runWithRequestId("req-123", () =>
        withSpan("bet.place", {}, async () => undefined),
      );

      expect(exporter.spans).toHaveLength(1);
      expect(exporter.spans[0].attributes.requestId).toBe("req-123");
    });

    it("supports a root request span driven by enterSpan/finishSpan", async () => {
      configureTracing({ enabled: true });

      const root = startSpan("http.server.request", { requestId: "req-9" });
      enterSpan(root);
      expect(getActiveSpan()).toBe(root);
      expect(getTraceContext().traceId).toBe(root.traceId);

      await withSpan("soroban.sorobanGetActiveRound", {}, async () => undefined);

      root.setAttribute("http.status_code", 500);
      finishSpan(root);

      expect(exporter.spans).toHaveLength(2);
      const [child] = exporter.spans;
      expect(child.parentSpanId).toBe(root.spanId);
    });
  });
});
