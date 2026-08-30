#!/usr/bin/env node
/**
 * scripts/smoke-test.js
 *
 * Post-deploy smoke test for Xelma Backend (#278, extended in #541).
 *
 * Checks that critical endpoints are reachable and return expected shapes
 * after a Render deployment. A non-zero exit signals the deploy workflow to
 * treat the deployment as broken — even when the process itself started fine.
 *
 * Supports both FULL and HACKATHON runtime modes:
 *
 *   FULL mode endpoints:
 *     GET /health                  → { status: "healthy" | "degraded" }
 *     GET /api/rounds              → { data: { rounds: [...] } }
 *     GET /api/price               → { asset, price_usd }
 *     GET /api/leaderboard         → array or { data: array }
 *
 *   HACKATHON mode endpoints:
 *     GET /health                  → { status: "healthy" | "degraded" }
 *     GET /api/rounds              → { data: { rounds: [...] } }
 *     GET /api/price               → { asset, price_usd }
 *
 * Optional Socket.IO connect test (full mode only):
 *   Attempts a transient WS connection and expects the "connect" event.
 *   Skipped when socket.io-client is not installed (zero hard deps).
 *
 * Usage:
 *   node scripts/smoke-test.js <base-url> [--mode full|hackathon]
 *   SMOKE_BASE_URL=https://your-service.onrender.com node scripts/smoke-test.js
 *
 * In CI / deploy.yml:
 *   run: node scripts/smoke-test.js ${{ vars.STAGING_URL }} --mode full
 *   run: node scripts/smoke-test.js ${{ vars.HACKATHON_URL }} --mode hackathon
 *
 * Options (env vars):
 *   SMOKE_BASE_URL      Base URL (overridden by argv[2] if provided)
 *   SMOKE_MODE          Runtime mode: "full" or "hackathon" (default: auto-detect)
 *   SMOKE_TIMEOUT_MS    Per-request timeout in ms  (default: 10000)
 *   SMOKE_RETRIES       Retry count for transient failures (default: 3)
 *   SMOKE_RETRY_DELAY   Delay between retries in ms (default: 3000)
 *   SMOKE_SOCKET        Set to "false" to skip the WebSocket check
 */

'use strict';

const https = require('https');
const http  = require('http');
const url   = require('url');

// --- Configuration -----------------------------------------------------------

// Parse --mode flag from argv
function parseMode() {
  const modeFlagIdx = process.argv.indexOf('--mode');
  if (modeFlagIdx !== -1 && process.argv[modeFlagIdx + 1]) {
    const mode = process.argv[modeFlagIdx + 1].toLowerCase();
    if (mode === 'full' || mode === 'hackathon') return mode;
    console.error('  ERROR: Invalid --mode "' + mode + '". Must be "full" or "hackathon".');
    process.exit(1);
  }
  return null;
}

var rawBaseUrl = (process.argv[2] || process.env.SMOKE_BASE_URL || '');
// Strip any --mode flags that were accidentally concatenated into the URL
rawBaseUrl = rawBaseUrl.replace(/ --mode.*$/, '');
var BASE_URL = rawBaseUrl.replace(/\/$/, '');
var SMOKE_MODE = parseMode() || (process.env.SMOKE_MODE ? process.env.SMOKE_MODE.toLowerCase() : null);
var TIMEOUT_MS   = Number(process.env.SMOKE_TIMEOUT_MS  != null ? process.env.SMOKE_TIMEOUT_MS : 10000);
var RETRIES      = Number(process.env.SMOKE_RETRIES     != null ? process.env.SMOKE_RETRIES    : 3);
var RETRY_DELAY  = Number(process.env.SMOKE_RETRY_DELAY != null ? process.env.SMOKE_RETRY_DELAY : 3000);
var SKIP_SOCKET  = (process.env.SMOKE_SOCKET || 'true') === 'false';

if (!BASE_URL) {
  console.error('');
  console.error('  ERROR: No base URL supplied.');
  console.error('');
  console.error('  Usage:  node scripts/smoke-test.js <base-url> [--mode full|hackathon]');
  console.error('  Or set: SMOKE_BASE_URL=https://your-service.onrender.com');
  console.error('  Or set: SMOKE_MODE=full|hackathon');
  console.error('');
  process.exit(1);
}

// --- Colour helpers (TTY-only) -----------------------------------------------

var isTTY = Boolean(process.stdout.isTTY);
function paint(s, code) { return isTTY ? '\x1b[' + code + 'm' + s + '\x1b[0m' : s; }
function green(s)  { return paint(s, '32'); }
function red(s)    { return paint(s, '31'); }
function yellow(s) { return paint(s, '33'); }
function bold(s)   { return paint(s, '1'); }
function dim(s)    { return paint(s, '2'); }

// --- Low-level HTTP helper ----------------------------------------------------

/**
 * Fires a single GET and resolves with { status, headers, body }.
 * Rejects after TIMEOUT_MS or on a network error.
 */
function get(endpoint) {
  return new Promise(function (resolve, reject) {
    var fullUrl = BASE_URL + endpoint;
    var parsed  = url.parse(fullUrl);
    var lib     = parsed.protocol === 'https:' ? https : http;

    var req = lib.get(
      Object.assign({}, parsed, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'xelma-smoke/1.0' },
        timeout: TIMEOUT_MS,
      }),
      function (res) {
        var raw = '';
        res.on('data', function (chunk) { raw += chunk; });
        res.on('end', function () {
          var body = null;
          try { body = JSON.parse(raw); } catch (_e) { /* non-JSON body is fine */ }
          resolve({ status: res.statusCode, headers: res.headers, body: body, raw: raw });
        });
      }
    );

    req.on('timeout', function () {
      req.destroy(new Error('Request timed out after ' + TIMEOUT_MS + 'ms'));
    });
    req.on('error', reject);
  });
}

/**
 * Retries fn up to RETRIES times with RETRY_DELAY ms between attempts.
 * Useful for Render cold-starts where the first request may arrive before the
 * service is ready.
 */
async function withRetry(fn, label) {
  var lastErr;
  for (var attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) {
        console.log(dim('    \u21a9  [' + label + '] attempt ' + attempt + '/' + RETRIES + ' failed (' + err.message + '), retrying in ' + RETRY_DELAY + 'ms\u2026'));
        await new Promise(function (r) { setTimeout(r, RETRY_DELAY); });
      }
    }
  }
  throw lastErr;
}

// --- Check definitions --------------------------------------------------------

/**
 * Each check returns a result object:
 *   { name, passed, required, warn, detail, skipped? }
 */

async function checkHealth() {
  var res = await get('/health');
  var status = res.status;
  var body = res.body;

  var responding = status === 200 || status === 503;
  var hasStatus  = body && typeof body.status === 'string';

  var healthy  = status === 200 && body && body.status === 'healthy';
  var degraded = status === 503 && hasStatus;

  return {
    name:     'GET /health',
    required: true,
    passed:   responding && hasStatus,
    warn:     degraded,
    detail:   !responding
      ? 'Unexpected HTTP ' + status
      : !hasStatus
        ? 'Response body missing `status` field'
        : degraded
          ? 'Service is degraded (status=' + body.status + ') \u2014 dependency issue'
          : 'status=' + body.status + ', uptime=' + (body.uptime != null ? body.uptime.toFixed(1) : '?') + 's',
  };
}

async function checkActiveRound() {
  var res = await get('/api/rounds');
  var status = res.status;
  var body = res.body;

  var acceptable = status === 200;

  var detail;
  if (status === 200) {
    var rounds = (body && body.data && body.data.rounds) || [];
    if (rounds.length > 0) {
      detail = 'Active round found (id=' + (rounds[0] && rounds[0].id ? rounds[0].id : '?') + ', mode=' + (rounds[0] && rounds[0].mode ? rounds[0].mode : '?') + ')';
    } else {
      detail = 'No active round \u2014 OK between rounds';
    }
  } else {
    detail = 'Unexpected HTTP ' + status;
  }

  return {
    name:     'GET /api/rounds',
    required: true,
    passed:   acceptable,
    warn:     false,
    detail:   detail,
  };
}

async function checkPrice() {
  var res = await get('/api/price');
  var status = res.status;
  var body = res.body;

  var ok       = status === 200;
  var hasAsset = ok && body && body.asset === 'XLM';
  var hasPrice = ok && body && body.price_usd !== undefined && body.price_usd !== null;

  return {
    name:     'GET /api/price',
    required: true,
    passed:   ok && hasAsset && hasPrice,
    warn:     ok && body && body.stale === true,
    detail:   !ok
      ? 'Unexpected HTTP ' + status
      : !hasAsset
        ? 'Response missing `asset` field'
        : !hasPrice
          ? 'Response missing `price_usd` field'
          : body && body.stale
            ? 'price_usd=' + body.price_usd + ' (stale \u2014 oracle may be lagging)'
            : 'price_usd=' + body.price_usd,
  };
}

async function checkLeaderboard() {
  var res = await get('/api/leaderboard');
  var status = res.status;
  var body = res.body;

  var ok = status === 200;
  var entries = ok
    ? (Array.isArray(body) ? body : (body && Array.isArray(body.data) ? body.data : null))
    : null;
  var hasEntries = entries !== null;

  return {
    name:     'GET /api/leaderboard',
    required: true,
    passed:   ok && hasEntries,
    warn:     false,
    detail:   !ok
      ? 'Unexpected HTTP ' + status
      : !hasEntries
        ? 'Response is not an array and has no `.data` array'
        : entries.length + ' entries returned',
  };
}

/**
 * Optional Socket.IO connectivity check.
 * Tries to require socket.io-client; silently skips if not installed.
 */
async function checkSocket() {
  var io;
  try {
    io = require('socket.io-client');
  } catch (_e) {
    return {
      name:     'WebSocket connect',
      required: false,
      passed:   true,
      warn:     false,
      detail:   'socket.io-client not installed \u2014 skipped (install it to enable)',
      skipped:  true,
    };
  }

  return new Promise(function (resolve) {
    var wsUrl  = BASE_URL.replace(/^http/, 'ws');
    var socket = io(wsUrl, {
      transports:         ['websocket'],
      reconnection:       false,
      timeout:            TIMEOUT_MS,
      forceNew:           true,
    });

    var timer = setTimeout(function () {
      socket.disconnect();
      resolve({
        name:     'WebSocket connect',
        required: false,
        passed:   false,
        warn:     true,
        detail:   'Timed out after ' + TIMEOUT_MS + 'ms \u2014 WebSocket may be disabled or rate-limited',
      });
    }, TIMEOUT_MS);

    socket.on('connect', function () {
      clearTimeout(timer);
      socket.disconnect();
      resolve({
        name:     'WebSocket connect',
        required: false,
        passed:   true,
        warn:     false,
        detail:   'Connected (transport=' + socket.io.engine.transport.name + ')',
      });
    });

    socket.on('connect_error', function (err) {
      clearTimeout(timer);
      socket.disconnect();
      resolve({
        name:     'WebSocket connect',
        required: false,
        passed:   false,
        warn:     true,
        detail:   'Connection error: ' + err.message,
      });
    });
  });
}

// --- Mode-aware check selection -----------------------------------------------

/**
 * Build the check list based on the resolved runtime mode.
 *
 * FULL mode:       health -> rounds -> price -> leaderboard -> WebSocket (optional)
 * HACKATHON mode:  health -> rounds -> price (mock data, no leaderboard)
 */
function buildCheckList(mode) {
  var checks = [
    { fn: checkHealth,      label: '/health' },
    { fn: checkActiveRound, label: '/api/rounds' },
    { fn: checkPrice,       label: '/api/price' },
  ];

  if (mode === 'full') {
    checks.push({ fn: checkLeaderboard, label: '/api/leaderboard' });
    if (!SKIP_SOCKET) {
      checks.push({ fn: checkSocket, label: 'WebSocket' });
    }
  }

  return checks;
}

// --- Runner -------------------------------------------------------------------

async function runChecks() {
  // Auto-detect mode by probing /health for DATA_MODE indicator
  var mode = SMOKE_MODE;
  if (!mode) {
    try {
      var probe = await get('/health');
      var dataMode = probe.body && (probe.body.dataMode || probe.body.mode);
      mode = dataMode === 'mock' ? 'hackathon' : 'full';
    } catch (_e) {
      mode = 'full'; // Default to full on detection failure
    }
  }

  var checkFns = buildCheckList(mode);

  console.log('');
  console.log(bold('Xelma Backend \u2014 Deployment Smoke Test'));
  console.log(bold('======================================'));
  console.log(dim('  Target:  ' + BASE_URL));
  console.log(dim('  Mode:    ' + mode.toUpperCase()));
  console.log(dim('  Timeout: ' + TIMEOUT_MS + 'ms  |  Retries: ' + RETRIES + '  |  Retry delay: ' + RETRY_DELAY + 'ms'));
  console.log('');

  var results = [];

  for (var i = 0; i < checkFns.length; i++) {
    var fn = checkFns[i].fn;
    var label = checkFns[i].label;
    var result;
    try {
      result = await withRetry(fn, label);
    } catch (err) {
      result = {
        name:     label,
        required: true,
        passed:   false,
        warn:     false,
        detail:   'Network error: ' + err.message,
      };
    }
    results.push(result);

    var icon   = result.skipped ? dim('  SKIP') :
                 result.passed  ? green('  PASS') :
                 result.warn    ? yellow('  WARN') :
                 red('  FAIL');
    var req    = result.required ? '' : dim(' [optional]');
    console.log(icon + '  ' + result.name + req);
    console.log(dim('         ' + result.detail));
  }

  var failures = results.filter(function (r) { return !r.passed && !r.warn && !r.skipped && r.required; });
  var warnings = results.filter(function (r) { return r.warn || (!r.passed && !r.required && !r.skipped); });
  var passes   = results.filter(function (r) { return r.passed && !r.warn; });
  var skipped  = results.filter(function (r) { return r.skipped; });

  console.log('');
  console.log(
    'Summary: ' + green(passes.length + ' passing') + ', ' +
    yellow(warnings.length + ' warnings') + ', ' +
    red(failures.length + ' failing') + ', ' +
    dim(skipped.length + ' skipped') + '.'
  );
  console.log('');

  if (failures.length > 0) {
    console.error(red('\u2716  Smoke test FAILED \u2014 deployment is not usable.'));
    console.error(red('   ' + failures.length + ' required check(s) did not pass:'));
    for (var j = 0; j < failures.length; j++) {
      console.error(red('   \u2022 ' + failures[j].name + ': ' + failures[j].detail));
    }
    console.error('');
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn(yellow('\u26a0  Smoke test passed with warnings \u2014 review the items above.'));
  } else {
    console.log(green('\u2714  Smoke test PASSED \u2014 deployment is healthy.'));
  }
  console.log('');
}

runChecks().catch(function (err) {
  console.error(red('\nUnhandled error in smoke test runner: ' + err.message));
  console.error(err.stack);
  process.exit(1);
});
