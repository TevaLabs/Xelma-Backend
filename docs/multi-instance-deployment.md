# Multi-instance deployment

Xelma Backend is safe to run on more than one replica, but only because every
critical cron job elects a single leader per tick. This document is the
reference for that mechanism: which jobs are protected, how to configure it,
what to watch, and how to deploy it on Render.

> **The one hard requirement:** every replica must point at the **same Redis
> instance** via `REDIS_URL`. Without shared Redis there is no leader election,
> and two replicas will create duplicate rounds and resolve the same round
> twice.

---

## Why a lock is required

Every replica boots the same schedulers, so every replica's cron fires on the
same tick. Unguarded, that means:

| Job | Damage from a duplicate run |
|---|---|
| `create-round` | Two `ACTIVE` rounds for one mode; users bet on a round that is not the live one |
| `oracle-resolve-rounds` | The same round resolved twice, with two payout passes |
| `auto-resolve-rounds` | As above, on the legacy resolution path |
| `reconcile-bets` | The same stranded bet reconciled twice against Soroban |
| `outbox-poll` | Duplicate notifications and duplicate WebSocket emits |
| retention / cleanup | Wasted duplicate DB sweeps; contention on large deletes |

[`src/utils/distributed-lock.ts`](../src/utils/distributed-lock.ts) makes
exactly one replica the leader for the duration of each run.

---

## How the lock works

**Acquire.** `SET xelma:lock:<job> <lockId> NX PX <ttl>`. The single replica
that wins runs the job; the others log a debug line and skip the tick. This is
normal — on a 3-replica deploy you should see 1 `acquired` and 2 `denied` per
tick, forever.

**Heartbeat.** While the job runs, a background timer re-`PEXPIRE`s the key
every `ttl/3`. This is the important part: **the TTL bounds failure detection,
not job duration.** A short TTL no longer means a long job loses its lock.

Before this mechanism existed, `oracle-resolve-rounds` held a fixed 60 s lock
while looping N rounds with up to 3 attempts and 5 s/10 s backoff sleeps each —
a busy tick ran for minutes, the key expired mid-run, a second replica acquired
the "free" lock, and both replicas resolved the same rounds.

**Fail closed.** A heartbeat that finds the key missing (`expired`) or owned by
a different id (`stolen`) marks the lock lost and fires the handle's
`AbortSignal`. Long jobs call `lock.assertHeld()` between units of work — per
round, per batch — so they stop *before* the next unsafe write rather than
racing the new leader. `withDistributedLock` also re-verifies ownership with
Redis when the job returns, closing the window where a job finishes between two
heartbeats.

**Watchdog.** `maxHoldSeconds` caps how long the heartbeat will keep a lock
alive, so a hung job cannot renew forever and starve every other replica. When
it fires, the job is aborted and the key is released immediately.

**In-process guard.** A second tick of the same job in the *same* process is
denied locally without touching Redis. This is the overlapping-cron case, which
a distributed lock alone does not cover.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `REDIS_URL` | unset | **Required for multi-instance.** Must be the same Redis for every replica. |
| `SCHEDULER_LOCK_REQUIRED` | `false` | Set to `true` to refuse to run any locked job unless Redis is reachable. |
| `ROUND_SCHEDULER_ENABLED` | `false` | Enables round creation/close crons. |
| `AUTO_RESOLVE_ENABLED` | `false` | Enables the legacy auto-resolution cron. |

### Redis availability policy

The behaviour on a Redis problem depends on whether Redis was *configured*,
because that is the only signal of operator intent available at runtime:

| Situation | Behaviour | Rationale |
|---|---|---|
| `REDIS_URL` set, Redis reachable | Normal leader election | — |
| `REDIS_URL` set, Redis **unreachable** | **Fail closed** — job skipped, error logged | A configured Redis means multiple replicas are intended; running unlocked would cause exactly the duplicate work the lock prevents |
| `REDIS_URL` unset | Runs behind the in-process guard, with a warning per run | Skipping would mean a single-replica deploy never creates or resolves a round at all |
| `REDIS_URL` unset + `SCHEDULER_LOCK_REQUIRED=true` | Fail closed | Opt-in hard guarantee |

> **If you run more than one replica, set `REDIS_URL`.** The unlocked fallback
> exists only so single-instance and local deploys work; it is not safe with
> two replicas, and it warns loudly on every run.

### Lock TTLs

TTLs were reviewed against actual job duration. With the heartbeat in place a
TTL only answers "how long does a *crashed* leader block the next one", so it
is deliberately kept short; `maxHoldSeconds` is the bound on a *live* run.

| Lock | TTL | Max hold | Cron |
|---|---|---|---|
| `create-round` | 30 s | 180 s | every 4 min |
| `close-eligible-rounds` | 30 s | 180 s | every 30 s |
| `oracle-resolve-rounds` | 60 s | 600 s | `ORACLE_RESOLVE_INTERVAL_SECONDS` (default 30 s) |
| `auto-resolve-rounds` | 30 s | 600 s | `AUTO_RESOLVE_INTERVAL_SECONDS` (default 30 s) |
| `reconcile-bets` | 70 s | 600 s | every 60 s |
| `outbox-poll` | poll interval + 5 s | 300 s | `OUTBOX_POLL_INTERVAL_SECONDS` (default 10 s) |
| `cleanup-old-notifications` | 60 s | 900 s | daily 02:00 |
| `run-retention-policies` | 60 s | 1800 s | daily 03:00 |
| `outbox-cleanup` | 60 s | 900 s | daily 03:30 |

When adding a job, pick the TTL from how long you can tolerate a crashed leader
blocking it, and `maxHoldSeconds` from a generous upper bound on a healthy run.
The renewal interval is derived (`ttl/3`) and clamped below the TTL, so a
misconfiguration cannot make the lock race its own expiry.

---

## Writing a lock-safe job

```typescript
await withDistributedLock(
   'my-job',
   async lock => {
      for (const item of items) {
         // Stop before the next write if leadership was lost.
         lock.assertHeld();
         await doUnsafeWork(item);
      }
   },
   { ttlSeconds: 30, maxHoldSeconds: 600 }
);
```

Rules:

1. **Call `assertHeld()` before every unsafe write**, not once at the start.
   The gaps that matter are the ones around `await` — DB round-trips, Soroban
   calls, and especially retry backoff sleeps.
2. **Let `LockLostError` propagate.** A `try/catch` around the work must
   re-throw it (`if (isLockLostError(error)) throw error;`), or the abort is
   silently swallowed and the job keeps writing.
3. **Handle it at the top level** with `isLockLostError` and record the run as
   `aborted`, not `failure` — losing a lock is a correct, safe outcome.
4. **Do not assume the job ran.** `withDistributedLock` returns `null` when the
   lock was not acquired *or* when the run aborted.

---

## Observability

All metrics are on `GET /metrics`. The `lock` label is the fixed job name, so
cardinality is bounded by the number of scheduled jobs.

| Metric | Labels | Meaning |
|---|---|---|
| `distributed_lock_acquisitions_total` | `lock`, `outcome` | `acquired`, `denied` (another replica), `denied_local` (overlapping tick), `unavailable` (fail-closed), `unlocked` (no Redis), `error` |
| `distributed_lock_renewals_total` | `lock`, `outcome` | `renewed`, `stolen`, `expired`, `error` |
| `distributed_lock_lost_total` | `lock`, `reason` | `stolen`, `expired`, `redis_error`, `max_hold_exceeded` |
| `distributed_locks_held` | `lock` | Locks currently held by this instance (0 or 1 per job) |
| `distributed_lock_held_seconds` | `lock` | Hold duration histogram — compare against the TTL when tuning |

Scheduler jobs also report `scheduler_runs_total{job,outcome}` with an
`aborted` outcome when a run stopped because the lock was lost.

### Healthy steady state

On an N-replica deploy, per tick: exactly one `acquired`, N-1 `denied`, a flat
stream of `renewed`, and **zero** `stolen` or `expired`.

### Alerts

```yaml
groups:
  - name: xelma-scheduler-locks
    rules:
      # Two instances briefly believed they were the leader. Investigate
      # immediately: duplicate resolution may have occurred.
      - alert: XelmaSchedulerLockStolen
        expr: increase(distributed_lock_lost_total{reason="stolen"}[10m]) > 0
        labels:
          severity: critical
        annotations:
          summary: "Scheduler lock {{ $labels.lock }} was stolen mid-job"

      # Redis is down and every replica is now skipping this job.
      - alert: XelmaSchedulerLockUnavailable
        expr: increase(distributed_lock_acquisitions_total{outcome="unavailable"}[10m]) > 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Scheduler job {{ $labels.lock }} is not running (Redis unreachable)"

      # REDIS_URL is missing. Fine on one replica, unsafe on several.
      - alert: XelmaSchedulerRunningUnlocked
        expr: increase(distributed_lock_acquisitions_total{outcome="unlocked"}[15m]) > 0
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Scheduler job {{ $labels.lock }} is running without a distributed lock"

      # A job is hanging long enough for the watchdog to kill it.
      - alert: XelmaSchedulerJobHung
        expr: increase(distributed_lock_lost_total{reason="max_hold_exceeded"}[30m]) > 0
        labels:
          severity: warning
        annotations:
          summary: "Scheduler job {{ $labels.lock }} exceeded its max hold time"

      # No leader is being elected at all — the job has stopped running.
      - alert: XelmaSchedulerNoLeader
        expr: sum by (lock) (increase(distributed_lock_acquisitions_total{outcome="acquired"}[15m])) == 0
        for: 15m
        labels:
          severity: critical
        annotations:
          summary: "No instance is acquiring the {{ $labels.lock }} lock"
```

See [prometheus-alerts-cookbook.md](./prometheus-alerts-cookbook.md) for the
oracle and Soroban alert rules.

---

## Render deployment

1. **Provision one Redis instance** and give every backend service the same
   `REDIS_URL`. A per-service Redis defeats the entire mechanism.
2. **Set the scheduler flags identically on every replica.** Leader election
   handles the duplication; disabling the crons on all but one instance instead
   removes the redundancy that scaling was for.
3. **Scale the web service** to N instances. No further changes are needed.
4. **Confirm after deploy** that `distributed_lock_acquisitions_total` shows
   one `acquired` and N-1 `denied` per tick, and that `outcome="unlocked"` is
   absent.

### Deploys and restarts

A rolling deploy can stop the leader mid-job. The heartbeat stops with the
process, the key expires within its TTL, and the next tick elects a new leader.
Because the leader aborts at its next `assertHeld()` checkpoint, worst case is a
partially-processed batch that the next run picks up — never a double write.

### Split deployment

If you run a separate worker service, keep `API_ONLY=true` on the API replicas
so only the worker service boots the schedulers. The locks still apply and cost
nothing extra; keep `REDIS_URL` set on every service either way, since the
outbox poller and bet-idempotency locks need it regardless.

### Socket.IO Redis adapter (Issue #494)

Real-time fanout across replicas requires the same `REDIS_URL`.

- **Module:** `src/utils/socket-adapter.ts` — `initializeSocketAdapter(io)` creates two Redis clients (`pub`/`sub`) and calls `io.adapter(createAdapter(pub, sub, { key: 'xelma:socket.io' }))`.
- **Fallback:** If `REDIS_URL` is unset or Redis is unreachable, Socket.IO keeps the in-memory adapter. Broadcasts then reach only clients on the same instance (safe for single-instance/dev, **not safe** for multi-instance notifications/price ticks).
- **Required config:**

  | Variable | Default | Purpose |
  |---|---|---|
  | `REDIS_URL` | unset | **Required for multi-instance WebSocket.** Same Redis as locks. |
  | Socket adapter `keyPrefix` | `xelma:socket.io` | Redis key namespace for adapter pub/sub. Override via `SocketAdapterConfig.keyPrefix` if you run multiple environments on one Redis. |
  | `connectTimeout` | 2000 ms | Redis client connect timeout. |

- **Verify multi-node emit:**

  ```bash
  REDIS_URL=redis://localhost:6379 npm run dev # on two terminals on different ports
  # Join both clients to the same room (e.g. round:abc) and emit via websocketService; both should receive the event
  ```

- **ACL hardening:** `src/socket.ts:isAuthorizedPrivateRoomJoin` ensures `user:<id>` rooms are only joinable by the owning `userId`. Unauthorized `join:notifications` with a foreign `user:<otherId>` is rejected with an `error` event and logged as a warning. Auto-join on connect still runs (`socket.join(user:<own>)`) so `websocketService.emitNotification(userId, …)` reaches the correct tenant even across adapters.

- **Monitoring:** `GET /metrics` exposes `websocket_connection_events_total` and `socket:io` metrics. After scale-up, `isUsingRedisAdapter(io)` should be `true` on every replica; otherwise broadcasts are instance-local.

### Redis-backed rate limiting (Issue #520)

Rate limits are enforced from the **same shared Redis** so throttles hold across
replicas. Without this, each replica runs its own in-process counter and an
attacker can simply rotate across instances to bypass a limit.

- **Module:** `src/middleware/rateLimiter.middleware.ts` builds one
  `RedisRateLimitStore` (`src/lib/redis.ts`) per limiter with a unique prefix
  (`xelma:rl:<limiter-name>:`), all over the app's single shared Redis client.
  Each counter is a fixed window stored in a Redis hash, incremented atomically
  with Lua so concurrent replicas can never double-count or race a window
  reset.
- **No Redis configured?** When `REDIS_URL` is unset every limiter keeps
  express-rate-limit's default in-process `MemoryStore`, so local single-node
development is completely unchanged.
- **Availability policy:** when Redis is configured but **unreachable**:

  | Situation | Behaviour | Rationale |
  |---|---|---|
  | `REDIS_URL` unset | In-process `MemoryStore` (per instance) | Single-node dev/demo; nothing to share |
  | `REDIS_URL` set, Redis reachable | Shared Redis counters | Throttles hold across replicas |
  | `REDIS_URL` set, Redis **unreachable**, `RATE_LIMIT_REDIS_FAIL_OPEN=true` (default) | **Fail open** — per-process fallback window, warning + metric per request | The API stays up; throttling briefly degrades to per-instance until Redis recovers |
  | `REDIS_URL` set, Redis **unreachable**, `RATE_LIMIT_REDIS_FAIL_OPEN=false` | **Fail closed** — request rejected (HTTP 500) | Shared throttling treated as a hard requirement; the outage is loud |

- **Required config:**

  | Variable | Default | Purpose |
  |---|---|---|
  | `REDIS_URL` | unset | **Required for shared rate limits.** Same Redis as locks and WebSocket. |
  | `RATE_LIMIT_REDIS_PREFIX` | `xelma:rl` | Redis key namespace (each limiter appends its name). |
  | `RATE_LIMIT_REDIS_FAIL_OPEN` | `true` | Outage policy — see the table above. |

- **Verify multi-process throttling:**

  ```bash
  # Terminal 1 and 2: two replicas, same Redis
  REDIS_URL=redis://localhost:6379 PORT=3000 npm run dev
  REDIS_URL=redis://localhost:6379 PORT=3001 npm run dev
  # Hammer one endpoint from a single IP; both replicas must observe the same
  # counter and start answering 429 at the same request count.
  for i in $(seq 1 15); do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/rounds/active; done
  # Then check the shared keyspace: redis-cli keys 'xelma:rl:*'
  ```

- **Monitoring:** `rate_limit_store_fallbacks_total{limiter}` counts requests
  served from the per-process fallback because Redis was unreachable — alert on
  it to catch a Redis outage that has silently degraded shared throttling.

---

## Testing

- [`src/tests/distributed-lock.spec.ts`](../src/tests/distributed-lock.spec.ts)
  — acquire/release/extend semantics, availability policy, metrics.
- [`src/tests/distributed-lock-multiworker.spec.ts`](../src/tests/distributed-lock-multiworker.spec.ts)
  — the real safety properties. Each "worker" is a separately-loaded copy of the
  lock module, so it has its own in-process guard exactly like a separate
  replica, and the only thing workers share is the Redis keyspace. Covers
  non-overlap under contention, heartbeat renewal past the TTL, abort on a
  stolen or expired key, the watchdog, and Redis-outage behaviour.
- [`src/tests/rate-limit-redis-store.integration.spec.ts`](../src/tests/rate-limit-redis-store.integration.spec.ts)
  — shared counters across store instances, per-prefix independence, and window
  expiry against a real Redis.

```bash
npx jest --selectProjects unit --testPathPattern="distributed-lock"
```
