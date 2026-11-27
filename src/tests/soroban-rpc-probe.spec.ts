import { describe, it, expect, beforeEach } from '@jest/globals';
import { sorobanRpcDurationSeconds } from '../metrics/application.metrics';
import {
  SOROBAN_RPC_PROBE_OPERATION,
  isSorobanRpcProbeEnabled,
  probeSorobanRpc,
  probeSorobanRpcCached,
  resetSorobanRpcProbeCache,
  sorobanRpcProbeCacheMs,
  sorobanRpcSlowThresholdMs,
} from '../services/soroban-rpc-probe';

interface RecordedCall {
  url: string;
  init?: { method?: string; body?: unknown };
}

function fakeFetch(body: unknown, options: { status?: number; delayMs?: number; raw?: string } = {}) {
  const calls: RecordedCall[] = [];
  const impl = (async (url: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ url, init });
    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    const status = options.status ?? 200;
    const text = options.raw !== undefined ? options.raw : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const HEALTHY = { jsonrpc: '2.0', id: 1, result: { status: 'healthy', latestLedger: 123 } };

async function probeHistogramCount(): Promise<number> {
  const metric = await sorobanRpcDurationSeconds.get();
  const entry = metric.values.find(
    (value) =>
      value.metricName === 'soroban_rpc_duration_seconds_count' &&
      value.labels.operation === SOROBAN_RPC_PROBE_OPERATION,
  );
  return entry ? Number(entry.value) : 0;
}

describe('probeSorobanRpc (Issue #994)', () => {
  beforeEach(() => {
    resetSorobanRpcProbeCache();
  });

  it('reports a healthy RPC with its latency and latest ledger', async () => {
    const { impl, calls } = fakeFetch(HEALTHY);
    const result = await probeSorobanRpc({ rpcUrl: 'http://rpc.test', fetchImpl: impl });

    expect(result.status).toBe('healthy');
    expect(result.latestLedger).toBe(123);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://rpc.test');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'getHealth',
    });
  });

  it('records every probe in the latency histogram', async () => {
    const before = await probeHistogramCount();
    const { impl } = fakeFetch(HEALTHY);
    await probeSorobanRpc({ rpcUrl: 'http://rpc.test', fetchImpl: impl });
    await probeSorobanRpc({ rpcUrl: 'http://rpc.test', fetchImpl: impl });
    expect(await probeHistogramCount()).toBe(before + 2);
  });

  it('marks a response slower than the threshold as slow', async () => {
    const { impl } = fakeFetch(HEALTHY, { delayMs: 30 });
    const result = await probeSorobanRpc({
      rpcUrl: 'http://rpc.test',
      fetchImpl: impl,
      slowThresholdMs: 5,
    });
    expect(result.status).toBe('slow');
    expect(result.latencyMs).toBeGreaterThanOrEqual(5);
  });

  it('is unhealthy when the RPC reports a non-healthy status', async () => {
    const { impl } = fakeFetch({ jsonrpc: '2.0', id: 1, result: { status: 'unhealthy' } });
    const result = await probeSorobanRpc({ rpcUrl: 'http://rpc.test', fetchImpl: impl });
    expect(result.status).toBe('unhealthy');
    expect(result.error).toBeTruthy();
  });

  it('is unhealthy on an HTTP error status', async () => {
    const { impl } = fakeFetch({}, { status: 503 });
    const result = await probeSorobanRpc({ rpcUrl: 'http://rpc.test', fetchImpl: impl });
    expect(result.status).toBe('unhealthy');
    expect(result.error).toBe('HTTP 503');
  });

  it('is unhealthy on a body that is not JSON', async () => {
    const { impl } = fakeFetch(undefined, { raw: 'not json' });
    const result = await probeSorobanRpc({ rpcUrl: 'http://rpc.test', fetchImpl: impl });
    expect(result.status).toBe('unhealthy');
  });

  it('is unhealthy when the connection fails', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await probeSorobanRpc({ rpcUrl: 'http://rpc.test', fetchImpl: failing });
    expect(result.status).toBe('unhealthy');
    expect(result.error).toBe('ECONNREFUSED');
  });

  it('times out with status timeout', async () => {
    const hanging = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const result = await probeSorobanRpc({
      rpcUrl: 'http://rpc.test',
      fetchImpl: hanging,
      timeoutMs: 20,
    });
    expect(result.status).toBe('timeout');
    expect(result.error).toContain('20 ms');
  });
});

describe('probeSorobanRpcCached (Issue #994)', () => {
  beforeEach(() => {
    resetSorobanRpcProbeCache();
  });

  it('reuses a recent result instead of probing again', async () => {
    const { impl, calls } = fakeFetch(HEALTHY);
    const options = { rpcUrl: 'http://rpc.test', fetchImpl: impl };
    const first = await probeSorobanRpcCached(options, 60_000);
    const second = await probeSorobanRpcCached(options, 60_000);
    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('probes again after the cache is reset', async () => {
    const { impl, calls } = fakeFetch(HEALTHY);
    const options = { rpcUrl: 'http://rpc.test', fetchImpl: impl };
    await probeSorobanRpcCached(options, 60_000);
    resetSorobanRpcProbeCache();
    await probeSorobanRpcCached(options, 60_000);
    expect(calls).toHaveLength(2);
  });

  it('does not cache when the cache window is 0', async () => {
    const { impl, calls } = fakeFetch(HEALTHY);
    const options = { rpcUrl: 'http://rpc.test', fetchImpl: impl };
    await probeSorobanRpcCached(options, 0);
    await probeSorobanRpcCached(options, 0);
    expect(calls).toHaveLength(2);
  });

  it('shares one in-flight probe between concurrent callers', async () => {
    const { impl, calls } = fakeFetch(HEALTHY, { delayMs: 20 });
    const options = { rpcUrl: 'http://rpc.test', fetchImpl: impl };
    await Promise.all([
      probeSorobanRpcCached(options, 0),
      probeSorobanRpcCached(options, 0),
      probeSorobanRpcCached(options, 0),
    ]);
    expect(calls).toHaveLength(1);
  });
});

describe('probe configuration helpers (Issue #994)', () => {
  it('is off under NODE_ENV=test unless explicitly enabled', () => {
    expect(isSorobanRpcProbeEnabled({ NODE_ENV: 'test' })).toBe(false);
    expect(isSorobanRpcProbeEnabled({ NODE_ENV: 'test', HEALTH_SOROBAN_RPC_PROBE: 'true' })).toBe(true);
  });

  it('is on by default outside tests and can be switched off', () => {
    expect(isSorobanRpcProbeEnabled({ NODE_ENV: 'production' })).toBe(true);
    expect(isSorobanRpcProbeEnabled({})).toBe(true);
    expect(isSorobanRpcProbeEnabled({ NODE_ENV: 'production', HEALTH_SOROBAN_RPC_PROBE: 'false' })).toBe(false);
    expect(isSorobanRpcProbeEnabled({ NODE_ENV: 'production', HEALTH_SOROBAN_RPC_PROBE: '0' })).toBe(false);
  });

  it('reads the slow threshold with a safe fallback', () => {
    expect(sorobanRpcSlowThresholdMs({})).toBe(1500);
    expect(sorobanRpcSlowThresholdMs({ HEALTH_SOROBAN_RPC_SLOW_MS: '250' })).toBe(250);
    for (const bad of ['abc', '0', '-5', '  ']) {
      expect(sorobanRpcSlowThresholdMs({ HEALTH_SOROBAN_RPC_SLOW_MS: bad })).toBe(1500);
    }
  });

  it('reads the cache window with a safe fallback and allows 0', () => {
    expect(sorobanRpcProbeCacheMs({})).toBe(5000);
    expect(sorobanRpcProbeCacheMs({ HEALTH_SOROBAN_RPC_CACHE_MS: '1200' })).toBe(1200);
    expect(sorobanRpcProbeCacheMs({ HEALTH_SOROBAN_RPC_CACHE_MS: '0' })).toBe(0);
    for (const bad of ['abc', '-1', '  ']) {
      expect(sorobanRpcProbeCacheMs({ HEALTH_SOROBAN_RPC_CACHE_MS: bad })).toBe(5000);
    }
  });
});
