#!/usr/bin/env node
/**
 * scripts/smoke-test.js
 *
 * Post-deploy smoke test for Xelma Backend (#278).
 *
 * Checks that critical endpoints are reachable and return expected shapes
 * after a Render deployment. A non-zero exit signals the deploy workflow to
 * treat the deployment as broken — even when the process itself started fine.
 *
 * Endpoints verified (all public / no auth required):
 *   GET /health                  → { status: "healthy" | "degraded" }
 *   GET /api/rounds/active       → 200 or 404 (both valid — no active round is OK)
 *   GET /api/price               → { asset, price_usd }
 *   GET /api/leaderboard         → array or { data: array }
 *
 * Optional Socket.IO connect test:
 *   Attempts a transient WS connection and expects the "connect" event.
 *   Skipped when socket.io-client is not installed (zero hard deps).
 *
 * Usage:
 *   node scripts/smoke-test.js https://your-service.onrender.com
 *   SMOKE_BASE_URL=https://your-service.onrender.com node scripts/smoke-test.js
 *
 * In CI / deploy.yml:
 *   run: node scripts/smoke-test.js ${{ vars.STAGING_URL }}
 *
 * Options (env vars):
 *   SMOKE_BASE_URL      Base URL (overridden by argv[2] if provided)
 *   SMOKE_TIMEOUT_MS    Per-request timeout in ms  (default: 10000)
 *   SMOKE_RETRIES       Retry count for transient failures (default: 3)
 *   SMOKE_RETRY_DELAY   Delay between retries in ms (default: 3000)
 *   SMOKE_SOCKET        Set to "false" to skip the WebSocket check
 */

'use strict';

const https = require('https');
const http  = require('http');
const url   = require('url');

// ─── Configuration ────────────────────────────────────────────────────────────

const BASE_URL     = (process.argv[2] || process.env.SMOKE_BASE_URL || '').replace(/\/$/, '');
const TIMEOUT_MS   = Number(process.env.SMOKE_TIMEOUT_MS  ?? 10_000);
const RETRIES      = Number(process.env.SMOKE_RETRIES     ?? 3);
const RETRY_DELAY  = Number(process.env.SMOKE_RETRY_DELAY ?? 3_000);
const SKIP_SOCKET  = (process.env.SMOKE_SOCKET ?? 'true') === 'false';

if (!BASE_URL) {
  console.error('');
  console.error('  ERROR: No base URL supplied.');
  console.error('');
  console.error('  Usage:  node scripts/smoke-test.js <base-url>');
  console.error('  Or set: SMOKE_BASE_URL=https://your-service.onrender.com');
  console.error('');
  process.exit(1);
}

// ─── Colour helpers (TTY-only) ─────────────────────────────────────────────

const isTTY   = Boolean(process.stdout.isTTY);
const paint   = (s, code) => isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;
const green   = (s) => paint(s, '32');
const red     = (s) => paint(s, '31');
const yellow  = (s) => paint(s, '33');
const bold    = (s) => paint(s, '1');
const dim     = (s) => paint(s, '2');

// ─── Low-level HTTP helper ──────────────────────────────────────────────────

/**
 * Fires a single GET and resolves with { status, headers, body }.
 * Rejects after TIMEOUT_MS or on a network error.
 */
function get(endpoint) {
  return new Promise((resolve, reject) => {
    const fullUrl  = `${BASE_URL}${endpoint}`;
    const parsed   = url.parse(fullUrl);
    const lib      = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(
      {
        ...parsed,
        headers: { 'Accept': 'application/json', 'User-Agent': 'xelma-smoke/1.0' },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(raw); } catch { /* non-JSON body is fine */ }
          resolve({ status: res.statusCode, headers: res.headers, body, raw });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
  });
}

/**
 * Retries `fn` up to `RETRIES` times with `RETRY_DELAY` ms between attempts.
 * Useful for Render cold-starts where the first request may arrive before the
 * service is ready.
 */
async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) {
        console.log(dim(`    ↩  [${label}] attempt ${attempt}/${RETRIES} failed (${err.message}), retrying in ${RETRY_DELAY}ms…`));
        await new Promise((r) => setTimeout(r, RETRY_DELAY));
      }
    }
  }
  throw lastErr;
}

// ─── Check definitions ──────────────────────────────────────────────────────

/**
 * Each check returns a result object:
 *   { name, passed, required, detail }
 */

async function checkHealth() {
  const { status, body } = await get('/health');

  // Accept 200 (healthy) or 503 (degraded but responding).
  // A 503 with a valid body means the server is up but a dependency is
  // struggling — still better than a network error / deploy crash.
  const responding = status === 200 || status === 503;
  const hasStatus  = body && typeof body.status === 'string';

  // Treat "degraded" as a warning rather than a hard failure so a transient
  // DB blip does not permanently fail the pipeline.
  const healthy    = status === 200 && body?.status === 'healthy';
  const degraded   = status === 503 && hasStatus;

  return {
    name:     'GET /health',
    required: true,
    passed:   responding && hasStatus,
    warn:     degraded,
    detail:   !responding
      ? `Unexpected HTTP ${status}`
      : !hasStatus
        ? 'Response body missing `status` field'
        : degraded
          ? `Service is degraded (status=${body.status}) — dependency issue`
          : `status=${body.status}, uptime=${body.uptime?.toFixed(1)}s`,
  };
}

async function checkActiveRound() {
  const { status, body } = await get('/api/rounds/active');

  // 200 = active round exists; 404 = no active round (valid between rounds)
  const acceptable = status === 200 || status === 404;

  let detail;
  if (status === 200) {
    detail = `Active round found (id=${body?.id ?? '?'}, mode=${body?.mode ?? '?'})`;
  } else if (status === 404) {
    detail = 'No active round — OK between rounds';
  } else {
    detail = `Unexpected HTTP ${status}`;
  }

  return {
    name:     'GET /api/rounds/active',
    required: true,
    passed:   acceptable,
    warn:     false,
    detail,
  };
}

async function checkPrice() {
  const { status, body } = await get('/api/price');

  const ok        = status === 200;
  const hasAsset  = ok && body?.asset === 'XLM';
  const hasPrice  = ok && body?.price_usd !== undefined && body?.price_usd !== null;

  return {
    name:     'GET /api/price',
    required: true,
    passed:   ok && hasAsset && hasPrice,
    warn:     ok && body?.stale === true,
    detail:   !ok
      ? `Unexpected HTTP ${status}`
      : !hasAsset
        ? 'Response missing `asset` field'
        : !hasPrice
          ? 'Response missing `price_usd` field'
          : body?.stale
            ? `price_usd=${body.price_usd} (stale — oracle may be lagging)`
            : `price_usd=${body.price_usd}`,
  };
}

async function checkLeaderboard() {
  const { status, body } = await get('/api/leaderboard');

  const ok = status === 200;
  // Accept either a plain array or a paginated { data: [...] } wrapper
  const entries = ok
    ? (Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data : null))
    : null;
  const hasEntries = entries !== null;

  return {
    name:     'GET /api/leaderboard',
    required: true,
    passed:   ok && hasEntries,
    warn:     false,
    detail:   !ok
      ? `Unexpected HTTP ${status}`
      : !hasEntries
        ? 'Response is not an array and has no `.data` array'
        : `${entries.length} entries returned`,
  };
}

/**
 * Optional Socket.IO connectivity check.
 * Tries to require socket.io-client; silently skips if not installed.
 */
async function checkSocket() {
  let io;
  try {
    io = require('socket.io-client');
  } catch {
    return {
      name:     'WebSocket connect',
      required: false,
      passed:   true,
      warn:     false,
      detail:   'socket.io-client not installed — skipped (install it to enable)',
      skipped:  true,
    };
  }

  return new Promise((resolve) => {
    const wsUrl  = BASE_URL.replace(/^http/, 'ws');
    const socket = io(wsUrl, {
      transports:         ['websocket'],
      reconnection:       false,
      timeout:            TIMEOUT_MS,
      forceNew:           true,
    });

    const timer = setTimeout(() => {
      socket.disconnect();
      resolve({
        name:     'WebSocket connect',
        required: false,
        passed:   false,
        warn:     true,
        detail:   `Timed out after ${TIMEOUT_MS}ms — WebSocket may be disabled or rate-limited`,
      });
    }, TIMEOUT_MS);

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.disconnect();
      resolve({
        name:     'WebSocket connect',
        required: false,
        passed:   true,
        warn:     false,
        detail:   `Connected (transport=${socket.io.engine.transport.name})`,
      });
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      socket.disconnect();
      resolve({
        name:     'WebSocket connect',
        required: false,
        passed:   false,
        warn:     true,
        detail:   `Connection error: ${err.message}`,
      });
    });
  });
}

// ─── Runner ────────────────────────────────────────────────────────────────

async function runChecks() {
  console.log('');
  console.log(bold('Xelma Backend — Deployment Smoke Test'));
  console.log(bold('======================================'));
  console.log(dim(`  Target:  ${BASE_URL}`));
  console.log(dim(`  Timeout: ${TIMEOUT_MS}ms  |  Retries: ${RETRIES}  |  Retry delay: ${RETRY_DELAY}ms`));
  console.log('');

  const checkFns = [
    { fn: checkHealth,       label: '/health' },
    { fn: checkActiveRound,  label: '/api/rounds/active' },
    { fn: checkPrice,        label: '/api/price' },
    { fn: checkLeaderboard,  label: '/api/leaderboard' },
    ...(SKIP_SOCKET ? [] : [{ fn: checkSocket, label: 'WebSocket' }]),
  ];

  const results = [];

  for (const { fn, label } of checkFns) {
    let result;
    try {
      result = await withRetry(fn, label);
    } catch (err) {
      result = {
        name:     label,
        required: true,
        passed:   false,
        warn:     false,
        detail:   `Network error: ${err.message}`,
      };
    }
    results.push(result);

    const icon   = result.skipped ? dim('  SKIP') :
                   result.passed  ? green('  PASS') :
                   result.warn    ? yellow('  WARN') :
                   red('  FAIL');
    const req    = result.required ? '' : dim(' [optional]');
    console.log(`${icon}  ${result.name}${req}`);
    console.log(dim(`         ${result.detail}`));
  }

  const failures = results.filter((r) => !r.passed && !r.warn && !r.skipped && r.required);
  const warnings = results.filter((r) => (r.warn || (!r.passed && !r.required && !r.skipped)));
  const passes   = results.filter((r) => r.passed && !r.warn);
  const skipped  = results.filter((r) => r.skipped);

  console.log('');
  console.log(
    `Summary: ${green(`${passes.length} passing`)}, ${yellow(`${warnings.length} warnings`)}, ${red(`${failures.length} failing`)}, ${dim(`${skipped.length} skipped`)}.`
  );
  console.log('');

  if (failures.length > 0) {
    console.error(red('✖  Smoke test FAILED — deployment is not usable.'));
    console.error(red(`   ${failures.length} required check(s) did not pass:`));
    for (const f of failures) {
      console.error(red(`   • ${f.name}: ${f.detail}`));
    }
    console.error('');
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn(yellow('⚠  Smoke test passed with warnings — review the items above.'));
  } else {
    console.log(green('✔  Smoke test PASSED — deployment is healthy.'));
  }
  console.log('');
}

runChecks().catch((err) => {
  console.error(red(`\nUnhandled error in smoke test runner: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});