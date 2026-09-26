#!/usr/bin/env node
/**
 * scripts/smoke-test.js
 *
 * One-command smoke test for BOTH Xelma runtime modes (#278, #541, #628).
 *
 * The repo ships two Express entrypoints (see src/app-factory.ts and
 * docs/runtime-modes.md) and they serve different surfaces. A smoke test that
 * only knows the full app's `/health` will happily pass while the hackathon
 * app's `/api/health`, `/api/prices`, or `/api/stats` are broken. This script
 * knows which URLs each mode actually exposes and validates their shapes.
 *
 * Modes and endpoints checked (all public / no auth required):
 *
 *   MODE=full        (npm run dev / src/index.ts, production)
 *     GET /health            → { success, data: { status, uptime, ... } }
 *     GET /api/rounds        → { success, data: { source, rounds: [...] } }
 *     GET /api/price         → { asset: "XLM", price_usd, ... }
 *     GET /api/prices        → { success, data: { BTC, ETH, XLM, ... } }
 *     GET /api/leaderboard   → { leaderboard: [...], totalUsers, ... }
 *
 *   MODE=hackathon   (npm run dev:hackathon / src/server.ts, demo)
 *     GET /api/health        → { success, data: { status: "ok"|"degraded", ... } }
 *     GET /api/rounds        → { success, data: { source, rounds: [...] } }
 *     GET /api/prices        → { success, data: { BTC, ETH, XLM, ... } }
 *     GET /api/stats         → { success, data: { totalRounds, totalUsers, ... } }
 *     GET /api/leaderboard   → { success, data: { leaderboard: [...] }, ... }
 *
 * Optional Socket.IO connect test:
 *   Attempts a transient WS connection and expects the "connect" event.
 *   Skipped when socket.io-client is not installed (zero hard deps).
 *
 * Usage (copy-paste):
 *   # Full app (default). Defaults to http://localhost:3001.
 *   npm run smoke-test
 *   npm run smoke-test -- http://localhost:3001
 *
 *   # Hackathon app (defaults to http://localhost:3001).
 *   npm run smoke-test:hackathon
 *   npm run smoke-test:hackathon -- http://localhost:3001
 *
 *   # Direct invocation / CI
 *   node scripts/smoke-test.js --mode=full http://your-service.onrender.com
 *   MODE=hackathon SMOKE_BASE_URL=http://localhost:3001 node scripts/smoke-test.js
 *
 * In CI / deploy.yml:
 *   env:
 *     SMOKE_BASE_URL: ${{ vars.STAGING_URL }}
 *     MODE: full            # or hackathon
 *   run: node scripts/smoke-test.js
 *
 * Options (argv):
 *   --mode=full|hackathon   Runtime mode to smoke test       (default: full)
 *   --help                  Print this help and exit
 *
 * Options (env vars):
 *   MODE                Runtime mode: "full" | "hackathon"    (default: full)
 *   SMOKE_BASE_URL      Base URL (overridden by argv if provided)
 *   SMOKE_PORT          Port used for the default localhost URL (default: 3001)
 *   SMOKE_TIMEOUT_MS    Per-request timeout in ms            (default: 10000)
 *   SMOKE_RETRIES       Retry count for transient failures   (default: 3)
 *   SMOKE_RETRY_DELAY   Delay between retries in ms          (default: 3000)
 *   SMOKE_SOCKET        Set to "false" to skip the WebSocket check
 *
 * Exit codes:
 *   0  every required check passed (warnings allowed)
 *   1  the first unexpected status / network error — the URL and status are
 *      printed so the failure is actionable in CI logs
 */

'use strict';

const https = require('https');
const http  = require('http');
const url   = require('url');

// ─── Argument + environment parsing ──────────────────────────────────────────

function printHelp() {
  const header = __filename.replace(process.cwd(), '.');
  console.log('');
  console.log(`Usage: node ${header} [--mode=full|hackathon] [base-url]`);
  console.log('');
  console.log('  --mode=full        Smoke the full production app (default)');
  console.log('  --mode=hackathon   Smoke the hackathon/demo app');
  console.log('');
  console.log('  base-url           Overrides SMOKE_BASE_URL / the default');
  console.log('                     http://localhost:3001');
  console.log('');
  console.log('Examples:');
  console.log('  npm run smoke-test');
  console.log('  npm run smoke-test:hackathon');
  console.log('  node scripts/smoke-test.js --mode=hackathon http://localhost:3001');
  console.log('');
}

const argv = process.argv.slice(2);
let cliMode = null;
let cliUrl  = null;

for (const token of argv) {
  if (token === '--help' || token === '-h') {
    printHelp();
    process.exit(0);
  } else if (token.startsWith('--mode=')) {
    cliMode = token.slice('--mode='.length);
  } else if (token.startsWith('--url=')) {
    cliUrl = token.slice('--url='.length);
  } else if (token.startsWith('-')) {
    console.error(`Unknown option: ${token}`);
    printHelp();
    process.exit(2);
  } else if (!cliUrl) {
    cliUrl = token;
  }
}

const MODE = (cliMode || process.env.MODE || process.env.SMOKE_MODE || 'full')
  .trim()
  .toLowerCase();

if (MODE !== 'full' && MODE !== 'hackathon') {
  console.error('');
  console.error(`  ERROR: Invalid mode "${MODE}". Expected "full" or "hackathon".`);
  console.error('');
  process.exit(2);
}

const DEFAULT_PORT = Number(process.env.SMOKE_PORT ?? 3001);
const DEFAULT_URL  = `http://localhost:${DEFAULT_PORT}`;
const BASE_URL     = (cliUrl || process.env.SMOKE_BASE_URL || DEFAULT_URL).replace(/\/$/, '');
const TIMEOUT_MS   = Number(process.env.SMOKE_TIMEOUT_MS  ?? 10_000);
const RETRIES      = Number(process.env.SMOKE_RETRIES     ?? 3);
const RETRY_DELAY  = Number(process.env.SMOKE_RETRY_DELAY ?? 3_000);
const SKIP_SOCKET  = (process.env.SMOKE_SOCKET ?? 'true') === 'false';

if (!BASE_URL) {
  console.error('');
  console.error('  ERROR: No base URL supplied.');
  console.error('');
  console.error('  Usage:  node scripts/smoke-test.js --mode=full <base-url>');
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
 * Fires a single GET and resolves with { status, headers, body, raw, url }.
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
        headers: { 'Accept': 'application/json', 'User-Agent': 'xelma-smoke/2.0' },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(raw); } catch { /* non-JSON body is fine */ }
          resolve({ status: res.statusCode, headers: res.headers, body, raw, url: fullUrl });
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

/**
 * Unwrap the `{ success, data }` envelope both apps use, falling back to the
 * raw body for endpoints that return an unwrapped payload (full `/api/price`,
 * full `/api/leaderboard`).
 */
function unwrap(body) {
  if (body && typeof body === 'object' && body.success === true && body.data !== undefined) {
    return body.data;
  }
  return body;
}

// ─── Check definitions ──────────────────────────────────────────────────────

/**
 * Every check returns:
 *   { name, path, url, status, passed, required, warn, skipped?, detail }
 */

async function checkHealth() {
  const path = MODE === 'full' ? '/health' : '/api/health';
  const { status, body, url: fullUrl } = await get(path);
  const data    = unwrap(body);
  const statusField = typeof data?.status === 'string'
    ? data.status
    : (typeof body?.status === 'string' ? body.status : null);

  // The full app always answers 200 (its `status` field carries the verdict);
  // a 503 is still a responding server, so warn rather than fail.
  const responding    = status === 200 || (MODE === 'full' && status === 503);
  const validStatuses = MODE === 'full'
    ? ['healthy', 'degraded', 'unhealthy']
    : ['ok', 'degraded'];
  const validStatus   = statusField !== null && validStatuses.includes(statusField);

  const degraded = responding && validStatus &&
    (statusField !== 'healthy' && statusField !== 'ok');

  return {
    name:     `GET ${path}`,
    path,
    url:      fullUrl,
    status,
    required: true,
    passed:   responding && validStatus,
    warn:     degraded,
    detail:   !responding
      ? `Unexpected HTTP ${status} from ${fullUrl}`
      : !validStatus
        ? `Response missing/invalid \`status\` field (got ${JSON.stringify(statusField)})`
        : degraded
          ? `Service reports "${statusField}" — dependency issue, server still responding`
          : `status=${statusField}, uptime=${data?.uptime?.toFixed(1) ?? 'n/a'}s`,
  };
}

async function checkRounds() {
  const path = '/api/rounds';
  const { status, body, url: fullUrl } = await get(path);
  const data = unwrap(body);
  const rounds = Array.isArray(data)
    ? data
    : (Array.isArray(data?.rounds) ? data.rounds
      : (Array.isArray(body?.rounds) ? body.rounds : null));

  let detail;
  if (status !== 200) {
    detail = `Unexpected HTTP ${status} from ${fullUrl}`;
  } else if (rounds === null) {
    detail = 'Response is not an array and has no `rounds` array';
  } else if (rounds.length > 0) {
    detail = `Active round found (id=${rounds[0]?.id ?? '?'}, mode=${rounds[0]?.mode ?? '?'})`;
  } else {
    detail = 'No active round — OK between rounds';
  }

  return {
    name:     `GET ${path}`,
    path,
    url:      fullUrl,
    status,
    required: true,
    passed:   status === 200 && rounds !== null,
    warn:     false,
    detail,
  };
}

/** Full app only: single-asset XLM oracle feed. */
async function checkLegacyPrice() {
  const path = '/api/price';
  const { status, body, url: fullUrl } = await get(path);
  const data = unwrap(body);
  const asset = data?.asset;
  const hasAsset = asset === 'XLM';
  const hasPriceField = data !== null && typeof data === 'object' && 'price_usd' in data;

  return {
    name:     `GET ${path}`,
    path,
    url:      fullUrl,
    status,
    required: true,
    passed:   status === 200 && hasAsset && hasPriceField,
    warn:     status === 200 && hasAsset && hasPriceField && data.price_usd == null,
    detail:   status !== 200
      ? `Unexpected HTTP ${status} from ${fullUrl}`
      : !hasAsset
        ? `Response missing/invalid \`asset\` (got ${JSON.stringify(asset)})`
        : !hasPriceField
          ? 'Response missing `price_usd` field'
          : data.price_usd == null
            ? 'price_usd is null — oracle has not produced a price yet'
            : `price_usd=${data.price_usd} (stale=${data.stale ?? false})`,
  };
}

/** Both apps: multi-asset BTC/ETH/XLM ticker. */
async function checkMultiPrices() {
  const path = '/api/prices';
  const { status, body, url: fullUrl } = await get(path);
  const data = unwrap(body);
  const hasAssets = data && ['BTC', 'ETH', 'XLM'].every((k) => typeof data[k] === 'number');

  return {
    name:     `GET ${path}`,
    path,
    url:      fullUrl,
    status,
    required: true,
    passed:   status === 200 && hasAssets,
    warn:     status === 200 && hasAssets && data.stale === true,
    detail:   status !== 200
      ? `Unexpected HTTP ${status} from ${fullUrl}`
      : !hasAssets
        ? 'Response missing numeric BTC/ETH/XLM prices'
        : data.stale
          ? `BTC=${data.BTC} ETH=${data.ETH} XLM=${data.XLM} (stale — provider failover)`
          : `BTC=${data.BTC} ETH=${data.ETH} XLM=${data.XLM}`,
  };
}

/** Hackathon app only: landing-page platform stats. */
async function checkStats() {
  const path = '/api/stats';
  const { status, body, url: fullUrl } = await get(path);
  const data = unwrap(body);
  const hasCounts = data && typeof data.totalRounds === 'number' && typeof data.totalUsers === 'number';

  return {
    name:     `GET ${path}`,
    path,
    url:      fullUrl,
    status,
    required: true,
    passed:   status === 200 && hasCounts,
    warn:     status === 200 && hasCounts && data.isFallback === true,
    detail:   status !== 200
      ? `Unexpected HTTP ${status} from ${fullUrl}`
      : !hasCounts
        ? 'Response missing `totalRounds` / `totalUsers`'
        : `totalRounds=${data.totalRounds}, totalUsers=${data.totalUsers}${data.isFallback ? ' (fallback constants)' : ''}`,
  };
}

/** Both apps: leaderboard (full answers raw, hackathon wraps in an envelope). */
async function checkLeaderboard() {
  const path = '/api/leaderboard';
  const { status, body, url: fullUrl } = await get(path);
  const data = unwrap(body);
  const entries = Array.isArray(body)
    ? body
    : (Array.isArray(data?.leaderboard) ? data.leaderboard
      : (Array.isArray(data) ? data : null));

  return {
    name:     `GET ${path}`,
    path,
    url:      fullUrl,
    status,
    required: true,
    passed:   status === 200 && entries !== null,
    warn:     false,
    detail:   status !== 200
      ? `Unexpected HTTP ${status} from ${fullUrl}`
      : entries === null
        ? 'Response has no `leaderboard` array'
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
      path:     '/socket.io',
      url:      BASE_URL,
      status:   null,
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
        path:     '/socket.io',
        url:      wsUrl,
        status:   null,
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
        path:     '/socket.io',
        url:      wsUrl,
        status:   null,
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
        path:     '/socket.io',
        url:      wsUrl,
        status:   null,
        required: false,
        passed:   false,
        warn:     true,
        detail:   `Connection error: ${err.message}`,
      });
    });
  });
}

/** The endpoints each mode is expected to expose. */
const MODE_CHECKS = {
  full: [
    { fn: checkHealth,        label: '/health' },
    { fn: checkRounds,        label: '/api/rounds' },
    { fn: checkLegacyPrice,   label: '/api/price' },
    { fn: checkMultiPrices,   label: '/api/prices' },
    { fn: checkLeaderboard,   label: '/api/leaderboard' },
  ],
  hackathon: [
    { fn: checkHealth,        label: '/api/health' },
    { fn: checkRounds,        label: '/api/rounds' },
    { fn: checkMultiPrices,   label: '/api/prices' },
    { fn: checkStats,         label: '/api/stats' },
    { fn: checkLeaderboard,   label: '/api/leaderboard' },
  ],
};

// ─── Runner ────────────────────────────────────────────────────────────────

function printResult(result) {
  const icon = result.skipped ? dim('  SKIP') :
               result.passed  ? green('  PASS') :
               result.warn    ? yellow('  WARN') :
               red('  FAIL');
  const req  = result.required ? '' : dim(' [optional]');
  console.log(`${icon}  ${result.name}${req}`);
  console.log(dim(`         ${result.detail}`));
}

/** Hard failures stop the run immediately, per the "fail on first" contract. */
function abortOnFailure(result) {
  console.error('');
  console.error(red('✖  Smoke test FAILED — deployment is not usable.'));
  console.error(red(`   ${result.name} [mode=${MODE}]`));
  console.error(red(`   URL:    ${result.url}`));
  console.error(red(`   Status: ${result.status ?? 'network error'}`));
  console.error(red(`   Detail: ${result.detail}`));
  console.error('');
  process.exit(1);
}

async function runChecks() {
  const checks = [...MODE_CHECKS[MODE]];
  if (!SKIP_SOCKET) {
    checks.push({ fn: checkSocket, label: 'WebSocket' });
  }

  console.log('');
  console.log(bold('Xelma Backend — Deployment Smoke Test'));
  console.log(bold('======================================'));
  console.log(dim(`  Mode:    ${MODE}`));
  console.log(dim(`  Target:  ${BASE_URL}`));
  console.log(dim(`  Timeout: ${TIMEOUT_MS}ms  |  Retries: ${RETRIES}  |  Retry delay: ${RETRY_DELAY}ms`));
  console.log('');

  const results = [];

  for (const { fn, label } of checks) {
    let result;
    try {
      result = await withRetry(fn, label);
    } catch (err) {
      result = {
        name:     label,
        path:     label,
        url:      `${BASE_URL}${label}`,
        status:   null,
        required: true,
        passed:   false,
        warn:     false,
        detail:   `Network error: ${err.message}`,
      };
    }
    results.push(result);
    printResult(result);

    // Fail fast: stop on the first required check that did not pass.
    if (result.required && !result.passed && !result.warn && !result.skipped) {
      abortOnFailure(result);
    }
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
    for (const f of failures) {
      console.error(red(`   • ${f.name}: ${f.detail}`));
    }
    console.error('');
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn(yellow('⚠  Smoke test passed with warnings — review the items above.'));
  } else {
    console.log(green(`✔  Smoke test PASSED — ${MODE} deployment is healthy.`));
  }
  console.log('');
}

runChecks().catch((err) => {
  console.error(red(`\nUnhandled error in smoke test runner: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
