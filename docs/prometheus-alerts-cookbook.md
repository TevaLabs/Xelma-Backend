# Prometheus alerts cookbook

This cookbook provides deployable Prometheus alert examples for the Xelma
price oracle and Soroban RPC integration. The examples assume the application
is scraped from `GET /metrics` and that the scrape job is named `xelma-backend`.
Replace the job or service selectors to match your Prometheus configuration.

## Metrics at a glance

All application labels are intentionally low-cardinality. They do not contain
wallet addresses, user IDs, round IDs, request bodies, or secrets.

| Metric | Labels | Meaning |
| --- | --- | --- |
| `oracle_up` | none | `1` only when polling is running, a price exists, and it is fresh |
| `oracle_last_update_timestamp_seconds` | none | Unix timestamp of the last successful price update; `0` means never |
| `oracle_price_staleness_seconds` | none | Current price age in seconds; `-1` means no price exists |
| `price_oracle_updates_total` | `provider` | Successful updates by provider |
| `price_oracle_fetch_failures_total` | `reason`, `provider` | Failed provider fetches |
| `oracle_resolve_blocked_total` | `reason` | Resolution attempts blocked by oracle safety checks |
| `soroban_rpc_calls_total` | `operation`, `outcome` | RPC calls by operation and `success`, `failure`, or `breaker_open` |
| `soroban_rpc_duration_seconds` | `operation` | RPC latency, including retries and breaker overhead |
| `circuit_breaker_state` | `breaker`, `state` | One-hot current breaker state (`closed`, `open`, `half-open`) |
| `circuit_breaker_state_changes_total` | `breaker`, `from_state`, `to_state`, `reason` | Breaker transitions |

Scheduler leader-election metrics (`distributed_lock_*`) and their alert rules
live in [multi-instance-deployment.md](./multi-instance-deployment.md).

## Example alert rules

Save the following as `xelma-alerts.yaml` and load it through your Prometheus
rule configuration. The `for` durations avoid paging on a single transient
scrape or upstream failure.

```yaml
groups:
  - name: xelma-oracle
    rules:
      - alert: XelmaOracleDown
        expr: oracle_up{job="xelma-backend"} == 0
        for: 2m
        labels:
          severity: critical
          component: oracle
        annotations:
          summary: Xelma price oracle is unavailable
          description: >-
            The oracle is not running, has no price, or its current price is
            stale. Automated round settlement should be considered unsafe.
          runbook: https://github.com/TevaLabs/Xelma-Backend/blob/main/docs/prometheus-alerts-cookbook.md#oracle-down

      - alert: XelmaOraclePriceStale
        expr: oracle_price_staleness_seconds{job="xelma-backend"} > 60
        for: 2m
        labels:
          severity: warning
          component: oracle
        annotations:
          summary: Xelma oracle price is stale
          description: >-
            The last successful price is older than the configured freshness
            window. Check provider failures and network connectivity.
          runbook: https://github.com/TevaLabs/Xelma-Backend/blob/main/docs/prometheus-alerts-cookbook.md#stale-price

      - alert: XelmaOracleNeverUpdated
        expr: oracle_last_update_timestamp_seconds{job="xelma-backend"} == 0
        for: 5m
        labels:
          severity: critical
          component: oracle
        annotations:
          summary: Xelma oracle has never received a price
          description: >-
            The process is running without a successful oracle update. Do not
            enable settlement until a fresh price is available.

      - alert: XelmaOracleProviderFailures
        expr: |
          sum by (provider) (rate(price_oracle_fetch_failures_total{job="xelma-backend"}[5m])) > 0
        for: 5m
        labels:
          severity: warning
          component: oracle
        annotations:
          summary: Xelma oracle provider failures detected
          description: Provider {{ $labels.provider }} is failing consistently.

      - alert: XelmaSettlementBlocked
        expr: |
          increase(oracle_resolve_blocked_total{job="xelma-backend"}[10m]) > 0
        labels:
          severity: warning
          component: oracle
        annotations:
          summary: Xelma settlement was blocked by oracle safety checks
          description: >-
            One or more round resolutions were refused. Inspect the reason
            label and confirm oracle freshness before retrying.

  - name: xelma-soroban
    rules:
      - alert: XelmaSorobanCircuitBreakerOpen
        expr: |
          circuit_breaker_state{job="xelma-backend", breaker="soroban-rpc", state="open"} == 1
        for: 1m
        labels:
          severity: critical
          component: soroban
        annotations:
          summary: Xelma Soroban RPC circuit breaker is open
          description: >-
            Money-path calls are being prevented or degraded because the
            Soroban RPC breaker is open. Check RPC availability and breaker
            transition logs.

      - alert: XelmaSorobanRpcFailures
        expr: |
          sum by (operation) (rate(soroban_rpc_calls_total{job="xelma-backend", outcome="failure"}[5m]))
          /
          clamp_min(sum by (operation) (rate(soroban_rpc_calls_total{job="xelma-backend"}[5m])), 0.001)
          > 0.25
        for: 5m
        labels:
          severity: warning
          component: soroban
        annotations:
          summary: Xelma Soroban RPC failure ratio is high
          description: >-
            More than 25% of {{ $labels.operation }} calls have failed during
            the last five minutes.

      - alert: XelmaSorobanRpcLatencyHigh
        expr: |
          histogram_quantile(0.95, sum by (operation, le) (
            rate(soroban_rpc_duration_seconds_bucket{job="xelma-backend"}[10m])
          )) > 10
        for: 10m
        labels:
          severity: warning
          component: soroban
        annotations:
          summary: Xelma Soroban RPC latency is high
          description: >-
            The p95 latency for {{ $labels.operation }} is above 10 seconds;
            requests may be approaching the configured timeout.

      - alert: XelmaSorobanBreakerChurning
        expr: |
          sum by (breaker) (increase(circuit_breaker_state_changes_total{job="xelma-backend"}[15m])) > 6
        for: 5m
        labels:
          severity: warning
          component: soroban
        annotations:
          summary: Xelma circuit breaker is changing state frequently
          description: >-
            Breaker {{ $labels.breaker }} changed state repeatedly. Investigate
            intermittent RPC failures, timeouts, or an unhealthy upstream.
```

## Recommended thresholds

- Set the stale-price threshold to the configured
  `ORACLE_STALENESS_THRESHOLD_MS` (the examples use 60 seconds, the default).
- Keep `XelmaOracleDown` at a longer `for` duration than the normal polling
  interval to avoid alerting on one missed cycle.
- Tune the Soroban latency threshold below the 15-second RPC call timeout if
  operators need warning time before requests time out.
- Keep `operation`, `provider`, and breaker names bounded to the values emitted
  by the application; never add unbounded request data as a Prometheus label.

## Triage checklist

### Oracle down

1. Check `/health` and confirm whether polling is running and whether a last
   update timestamp exists.
2. Inspect `price_oracle_fetch_failures_total` by `provider` and `reason`.
3. Verify outbound connectivity, provider rate limits, and the configured
   oracle URLs.
4. Do not manually force resolution while `oracle_up` is `0`; the settlement
   guard exists to prevent stale-price settlement.

### Stale price

1. Compare `oracle_price_staleness_seconds` with
   `ORACLE_STALENESS_THRESHOLD_MS / 1000`.
2. Determine whether all providers are failing or only the active provider.
3. After recovery, verify `oracle_last_update_timestamp_seconds` advances and
   `oracle_up` returns to `1` before resuming settlement.

### Soroban breaker open

1. Check `soroban_rpc_calls_total{outcome="failure"}` and
   `soroban_rpc_duration_seconds` for the affected operation.
2. Inspect application logs for the breaker transition reason and next probe
   time.
3. Validate Soroban RPC endpoint health, network selection, contract ID, and
   credentials without exposing secrets.
4. Allow the configured half-open probe to recover the breaker; do not restart
   repeatedly as a substitute for fixing the upstream.

## Testing the rules

Validate syntax and expressions before deployment:

```bash
promtool check rules xelma-alerts.yaml
promtool test rules xelma-alert-tests.yaml
```

The alert examples are intentionally independent of a particular Alertmanager
routing setup. Route `component: oracle` and `component: soroban` according to
your on-call policy, and preserve the `runbook` annotations when adapting them.
