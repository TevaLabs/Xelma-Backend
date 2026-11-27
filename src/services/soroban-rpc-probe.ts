import {
  sorobanRpcCallsTotal,
  sorobanRpcDurationSeconds,
} from '../metrics/application.metrics';

/**
 * Active Soroban RPC latency probe for the health endpoint (Issue #994).
 *
 * `sorobanService.getHealth()` only reports whether the service was
 * initialised; it says nothing about how the RPC node is actually behaving.
 * This probe sends one JSON-RPC `getHealth` request, times it, and records
 * the duration in the existing `soroban_rpc_duration_seconds` histogram under
 * `operation="health_probe"`, so the latency distribution is visible on
 * /metrics as well as in the health payload.
 */

export type SorobanRpcProbeStatus = 'healthy' | 'slow' | 'unhealthy' | 'timeout';

export interface SorobanRpcProbeResult {
  status: SorobanRpcProbeStatus;
  /** Round-trip time of the probe in milliseconds. */
  latencyMs: number;
  latestLedger?: number;
  error?: string;
}

export interface SorobanRpcProbeOptions {
  rpcUrl: string;
  timeoutMs?: number;
  slowThresholdMs?: number;
  fetchImpl?: typeof fetch;
}

export const SOROBAN_RPC_PROBE_OPERATION = 'health_probe';

const DEFAULT_PROBE_TIMEOUT_MS = 3000;
const DEFAULT_SLOW_THRESHOLD_MS = 1500;
const DEFAULT_CACHE_MS = 5000;
const MAX_PROBE_BODY_CHARS = 64 * 1024;

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The probe is on by default outside tests so deployments get the signal
 * without configuration. `HEALTH_SOROBAN_RPC_PROBE=true|false` overrides it;
 * under NODE_ENV=test it is off unless explicitly enabled, so unit tests never
 * make outbound RPC calls.
 */
export function isSorobanRpcProbeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.HEALTH_SOROBAN_RPC_PROBE?.trim().toLowerCase();
  if (raw === 'true' || raw === '1') {
    return true;
  }
  if (raw === 'false' || raw === '0') {
    return false;
  }
  return env.NODE_ENV !== 'test';
}

/** Latency above this (ms) marks the RPC as `slow` and the service `degraded`. */
export function sorobanRpcSlowThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.HEALTH_SOROBAN_RPC_SLOW_MS, DEFAULT_SLOW_THRESHOLD_MS);
}

/** How long (ms) a probe result is reused. `0` disables caching. */
export function sorobanRpcProbeCacheMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HEALTH_SOROBAN_RPC_CACHE_MS;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_CACHE_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CACHE_MS;
}

function parseHealthBody(text: string): { healthy: boolean; latestLedger?: number } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) {
      return { healthy: false };
    }
    const result = (parsed as { result?: unknown }).result;
    if (typeof result !== 'object' || result === null) {
      return { healthy: false };
    }
    const { status, latestLedger } = result as { status?: unknown; latestLedger?: unknown };
    return {
      healthy: status === 'healthy',
      ...(typeof latestLedger === 'number' ? { latestLedger } : {}),
    };
  } catch {
    return { healthy: false };
  }
}

async function runProbe(
  doFetch: typeof fetch,
  rpcUrl: string,
  controller: AbortController,
  timeoutMs: number,
  slowThresholdMs: number,
  startedAt: number,
): Promise<SorobanRpcProbeResult> {
  try {
    const response = await doFetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      signal: controller.signal,
      redirect: 'error',
    });
    const text = await response.text();
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      return { status: 'unhealthy', latencyMs, error: `HTTP ${response.status}` };
    }
    if (text.length > MAX_PROBE_BODY_CHARS) {
      return { status: 'unhealthy', latencyMs, error: 'RPC response too large' };
    }
    const body = parseHealthBody(text);
    if (!body.healthy) {
      return { status: 'unhealthy', latencyMs, error: 'RPC reported not healthy' };
    }
    return {
      status: latencyMs > slowThresholdMs ? 'slow' : 'healthy',
      latencyMs,
      ...(body.latestLedger !== undefined ? { latestLedger: body.latestLedger } : {}),
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (controller.signal.aborted) {
      return {
        status: 'timeout',
        latencyMs,
        error: `RPC probe timed out after ${timeoutMs} ms`,
      };
    }
    return {
      status: 'unhealthy',
      latencyMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function recordProbeMetrics(result: SorobanRpcProbeResult): void {
  sorobanRpcDurationSeconds.observe(
    { operation: SOROBAN_RPC_PROBE_OPERATION },
    result.latencyMs / 1000,
  );
  sorobanRpcCallsTotal.inc({
    operation: SOROBAN_RPC_PROBE_OPERATION,
    outcome: result.status === 'healthy' || result.status === 'slow' ? 'success' : 'failure',
  });
}

/** Sends one timed JSON-RPC `getHealth` request and records its latency. */
export async function probeSorobanRpc(
  options: SorobanRpcProbeOptions,
): Promise<SorobanRpcProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const slowThresholdMs = options.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const result = await runProbe(
      doFetch,
      options.rpcUrl,
      controller,
      timeoutMs,
      slowThresholdMs,
      startedAt,
    );
    recordProbeMetrics(result);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

let cached: { at: number; result: SorobanRpcProbeResult } | undefined;
let inflight: Promise<SorobanRpcProbeResult> | undefined;

/**
 * Like {@link probeSorobanRpc}, but reuses a recent result and shares one
 * in-flight probe between concurrent callers, so frequent Kubernetes probes
 * never turn into a stream of RPC calls.
 */
export async function probeSorobanRpcCached(
  options: SorobanRpcProbeOptions,
  cacheMs: number = sorobanRpcProbeCacheMs(),
): Promise<SorobanRpcProbeResult> {
  if (cacheMs > 0 && cached && Date.now() - cached.at < cacheMs) {
    return cached.result;
  }
  if (inflight) {
    return inflight;
  }
  inflight = probeSorobanRpc(options)
    .then((result) => {
      cached = { at: Date.now(), result };
      return result;
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}

/** Clears the cached probe result (used by tests). */
export function resetSorobanRpcProbeCache(): void {
  cached = undefined;
  inflight = undefined;
}
