import { describe, expect, it } from '@jest/globals';
import { hackathonSwaggerSpec } from '../docs/hackathon-openapi';

const REQUIRED_HACKATHON_PATHS: Array<{ path: string; method: string }> = [
  { path: '/api/auth/challenge', method: 'post' },
  { path: '/api/auth/connect', method: 'post' },
  { path: '/health', method: 'get' },
  { path: '/api/prices', method: 'get' },
  { path: '/api/stats', method: 'get' },
  { path: '/api/rounds', method: 'get' },
  { path: '/api/leaderboard', method: 'get' },
  // Education surface is documented for the hackathon app even though it is
  // only mounted at runtime when ENABLE_EDUCATION=true (#532). The tip route
  // keeps plain-comment docs and is intentionally absent from the specs.
  { path: '/api/education/guides', method: 'get' },
];

describe('Hackathon OpenAPI spec', () => {
  it('documents hackathon routes', () => {
    const paths = (hackathonSwaggerSpec as { paths?: Record<string, Record<string, unknown>> }).paths ?? {};

    for (const { path, method } of REQUIRED_HACKATHON_PATHS) {
      expect(paths[path]?.[method]).toBeDefined();
    }
  });

  it('documents /api/prices as multi-asset and notes /api/price is production-only', () => {
    const paths = (hackathonSwaggerSpec as { paths?: Record<string, any> }).paths ?? {};
    const pricesOp = paths['/api/prices']?.get;

    expect(pricesOp).toBeDefined();
    expect(String(pricesOp.description ?? '')).toMatch(/\/api\/price/);
    expect(paths['/api/price']).toBeUndefined();
  });
});
