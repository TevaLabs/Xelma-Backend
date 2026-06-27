/**
 * Repeatable load-test harness for realtime gameplay paths (#21).
 *
 * Provides percentile math, concurrent HTTP load execution, and WebSocket
 * fanout measurement so performance.spec.ts can assert stable baselines
 * without pulling in external benchmarking tools.
 */

import type { Socket } from "socket.io-client";

export interface LatencyStats {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface LoadTestSample {
  success: boolean;
  latencyMs: number;
  statusCode?: number;
}

export interface LoadTestResult {
  total: number;
  successes: number;
  failures: number;
  errorRate: number;
  durationMs: number;
  throughputRps: number;
  latencyMs: LatencyStats;
  samples: LoadTestSample[];
}

export interface WebSocketFanoutResult {
  clientCount: number;
  deliveredCount: number;
  deliveryRate: number;
  errorRate: number;
  fanoutMs: LatencyStats;
}

export interface LoadTestConfig {
  baseline: {
    challengeLatencyMs: number;
    activeRoundsLatencyMs: number;
    submitPredictionLatencyMs: number;
  };
  prediction: {
    concurrency: number;
    iterations: number;
    minThroughputRps: number;
    maxP95LatencyMs: number;
    maxErrorRate: number;
  };
  websocket: {
    clientCount: number;
    minDeliveryRate: number;
    maxP95FanoutMs: number;
  };
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveFloat(
  value: string | undefined,
  fallback: number
): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Read load-test knobs from the environment. Defaults are tuned for CI
 * runners; raise concurrency locally to stress-test a running dev server.
 */
export function getLoadTestConfig(): LoadTestConfig {
  return {
    baseline: {
      challengeLatencyMs: parsePositiveInt(
        process.env.LOAD_TEST_BASELINE_CHALLENGE_MS,
        200
      ),
      activeRoundsLatencyMs: parsePositiveInt(
        process.env.LOAD_TEST_BASELINE_ACTIVE_ROUNDS_MS,
        150
      ),
      submitPredictionLatencyMs: parsePositiveInt(
        process.env.LOAD_TEST_BASELINE_SUBMIT_MS,
        300
      ),
    },
    prediction: {
      concurrency: parsePositiveInt(
        process.env.LOAD_TEST_PREDICTION_CONCURRENCY,
        10
      ),
      iterations: parsePositiveInt(
        process.env.LOAD_TEST_PREDICTION_ITERATIONS,
        30
      ),
      minThroughputRps: parsePositiveFloat(
        process.env.LOAD_TEST_PREDICTION_MIN_RPS,
        5
      ),
      maxP95LatencyMs: parsePositiveInt(
        process.env.LOAD_TEST_PREDICTION_P95_MS,
        500
      ),
      maxErrorRate: parsePositiveFloat(
        process.env.LOAD_TEST_PREDICTION_MAX_ERROR_RATE,
        0.05
      ),
    },
    websocket: {
      clientCount: parsePositiveInt(process.env.LOAD_TEST_WS_CLIENTS, 20),
      minDeliveryRate: parsePositiveFloat(
        process.env.LOAD_TEST_WS_MIN_DELIVERY_RATE,
        1
      ),
      maxP95FanoutMs: parsePositiveInt(
        process.env.LOAD_TEST_WS_P95_MS,
        250
      ),
    },
  };
}

/** Nearest-rank percentile on a pre-sorted array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;

  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.min(Math.max(rank, 0), sorted.length - 1);
  return sorted[index]!;
}

export function computeLatencyStats(values: number[]): LatencyStats {
  if (values.length === 0) {
    return { min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);

  return {
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

export function summarizeLoadTest(
  samples: LoadTestSample[],
  durationMs: number
): LoadTestResult {
  const successes = samples.filter((sample) => sample.success).length;
  const failures = samples.length - successes;
  const latencies = samples.map((sample) => sample.latencyMs);
  const safeDurationMs = Math.max(durationMs, 1);

  return {
    total: samples.length,
    successes,
    failures,
    errorRate: samples.length > 0 ? failures / samples.length : 0,
    durationMs: safeDurationMs,
    throughputRps: (samples.length / safeDurationMs) * 1000,
    latencyMs: computeLatencyStats(latencies),
    samples,
  };
}

export interface RunConcurrentLoadOptions {
  concurrency: number;
  iterations: number;
  task: (index: number) => Promise<LoadTestSample>;
}

/**
 * Run `iterations` tasks with at most `concurrency` in flight at once.
 * Returns per-request samples plus aggregate throughput and latency stats.
 */
export async function runConcurrentLoad(
  options: RunConcurrentLoadOptions
): Promise<LoadTestResult> {
  const { concurrency, iterations, task } = options;
  const samples: LoadTestSample[] = new Array(iterations);
  let nextIndex = 0;
  const startedAt = Date.now();

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= iterations) break;
      samples[index] = await task(index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, iterations) },
    () => worker()
  );
  await Promise.all(workers);

  return summarizeLoadTest(samples, Date.now() - startedAt);
}

export function formatLoadTestReport(label: string, result: LoadTestResult): string {
  const { latencyMs } = result;
  return [
    `[LOAD] ${label}`,
    `  total=${result.total} success=${result.successes} fail=${result.failures} errorRate=${(result.errorRate * 100).toFixed(1)}%`,
    `  duration=${result.durationMs}ms throughput=${result.throughputRps.toFixed(2)} rps`,
    `  latency ms: p50=${latencyMs.p50} p95=${latencyMs.p95} p99=${latencyMs.p99} max=${latencyMs.max}`,
  ].join("\n");
}

export function formatFanoutReport(
  label: string,
  result: WebSocketFanoutResult
): string {
  const { fanoutMs } = result;
  return [
    `[LOAD] ${label}`,
    `  clients=${result.clientCount} delivered=${result.deliveredCount} rate=${(result.deliveryRate * 100).toFixed(1)}% errorRate=${(result.errorRate * 100).toFixed(1)}%`,
    `  fanout ms: p50=${fanoutMs.p50} p95=${fanoutMs.p95} max=${fanoutMs.max}`,
  ].join("\n");
}

export interface MeasureWebSocketFanoutOptions {
  clients: Socket[];
  eventName: string;
  emit: () => void;
  timeoutMs?: number;
}

/**
 * Measure how quickly a room broadcast reaches connected clients.
 * Each client must already be connected; callers join rooms before invoking.
 */
export async function measureWebSocketFanout(
  options: MeasureWebSocketFanoutOptions
): Promise<WebSocketFanoutResult> {
  const { clients, eventName, emit, timeoutMs = 5000 } = options;
  const deliveryMs: number[] = [];
  const startedAt = Date.now();

  const deliveries = clients.map(
    (client) =>
      new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          client.off(eventName, onEvent);
          reject(new Error(`Timeout waiting for ${eventName}`));
        }, timeoutMs);

        function onEvent(): void {
          clearTimeout(timer);
          client.off(eventName, onEvent);
          resolve(Date.now() - startedAt);
        }

        client.on(eventName, onEvent);
      })
  );

  emit();

  const settled = await Promise.allSettled(deliveries);
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      deliveryMs.push(outcome.value);
    }
  }

  const deliveredCount = deliveryMs.length;
  const clientCount = clients.length;
  const deliveryRate = clientCount === 0 ? 0 : deliveredCount / clientCount;

  return {
    clientCount,
    deliveredCount,
    deliveryRate,
    errorRate: 1 - deliveryRate,
    fanoutMs: computeLatencyStats(deliveryMs),
  };
}
