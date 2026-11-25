import { describe, expect, it } from '@jest/globals';
import { hackathonSwaggerSpec } from '../docs/hackathon-openapi';
import { sharedComponents } from '../docs/shared-components';

const REQUIRED_HACKATHON_PATHS: Array<{ path: string; method: string }> = [
  { path: '/api/auth/challenge', method: 'post' },
  { path: '/api/auth/connect', method: 'post' },
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

  it('documents /api/prices as multi-asset and notes /api/price is production-only', () => {
    const paths = (hackathonSwaggerSpec as { paths?: Record<string, any> }).paths ?? {};
    const pricesOp = paths['/api/prices']?.get;

    expect(pricesOp).toBeDefined();
    expect(String(pricesOp.description ?? '')).toMatch(/\/api\/price/);
    expect(paths['/api/price']).toBeUndefined();
  });

  it('shares NotFoundResponse and PaginationMeta schemas from sharedComponents', () => {
    const schemas = (hackathonSwaggerSpec as { components?: { schemas?: Record<string, any> } }).components?.schemas ?? {};

    expect(schemas.NotFoundResponse).toBeDefined();
    expect(schemas.NotFoundResponse).toEqual(sharedComponents.schemas.NotFoundResponse);
    expect(schemas.NotFoundResponse.required).toEqual(['error', 'message', 'code', 'path', 'timestamp']);

    expect(schemas.PaginationMeta).toBeDefined();
    expect(schemas.PaginationMeta).toEqual(sharedComponents.schemas.PaginationMeta);
  });
});
