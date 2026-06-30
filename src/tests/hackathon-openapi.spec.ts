import { describe, expect, it } from '@jest/globals';
import { hackathonSwaggerSpec } from '../docs/hackathon-openapi';

const REQUIRED_HACKATHON_PATHS: Array<{ path: string; method: string }> = [
  { path: '/health', method: 'get' },
  { path: '/api/prices', method: 'get' },
  { path: '/api/stats', method: 'get' },
  { path: '/api/rounds', method: 'get' },
  { path: '/api/leaderboard', method: 'get' },
];

describe('Hackathon OpenAPI spec', () => {
  it('documents hackathon routes', () => {
    const paths = (hackathonSwaggerSpec as { paths?: Record<string, Record<string, unknown>> }).paths ?? {};

    for (const { path, method } of REQUIRED_HACKATHON_PATHS) {
      expect(paths[path]?.[method]).toBeDefined();
    }
  });
});
