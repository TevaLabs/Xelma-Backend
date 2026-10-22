import { describe, expect, it, afterAll, beforeAll } from '@jest/globals';
import http from 'http';
import { execFile } from 'child_process';
import path from 'path';

describe('Smoke test script health check (Issue #897)', () => {
  let server: http.Server;
  let serverPort: number;
  let lastRequestedPath = '';

  beforeAll((done) => {
    server = http.createServer((req, res) => {
      lastRequestedPath = req.url || '';
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { status: 'healthy', uptime: 42 } }));
      } else if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy', uptime: 10 }));
      } else if (req.url === '/api/rounds') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { rounds: [] } }));
      } else if (req.url === '/api/price') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ asset: 'XLM', price_usd: '0.2891' }));
      } else if (req.url === '/api/leaderboard') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as any;
      serverPort = address.port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  it('probes default /health when HEALTHCHECK_PATH is unset', (done) => {
    const smokeScript = path.resolve(__dirname, '../../scripts/smoke-test.js');
    execFile(
      process.execPath,
      [smokeScript, `http://127.0.0.1:${serverPort}`],
      {
        env: {
          ...process.env,
          SMOKE_SOCKET: 'false',
          SMOKE_RETRIES: '1',
          SMOKE_TIMEOUT_MS: '2000',
        },
      },
      (error, stdout, stderr) => {
        expect(error).toBeNull();
        expect(stdout).toContain('PASS  GET /health');
        expect(stdout).toContain('Smoke test PASSED');
        done();
      }
    );
  });

  it('respects HEALTHCHECK_PATH and handles enveloped hackathon health responses', (done) => {
    const smokeScript = path.resolve(__dirname, '../../scripts/smoke-test.js');
    execFile(
      process.execPath,
      [smokeScript, `http://127.0.0.1:${serverPort}`],
      {
        env: {
          ...process.env,
          HEALTHCHECK_PATH: '/api/health',
          SMOKE_SOCKET: 'false',
          SMOKE_RETRIES: '1',
          SMOKE_TIMEOUT_MS: '2000',
        },
      },
      (error, stdout, stderr) => {
        expect(error).toBeNull();
        expect(stdout).toContain('PASS  GET /api/health');
        expect(stdout).toContain('status=healthy');
        expect(stdout).toContain('Smoke test PASSED');
        done();
      }
    );
  });
});
