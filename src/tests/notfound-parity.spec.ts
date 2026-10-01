import { describe, it, expect, beforeAll } from '@jest/globals';
import request from 'supertest';
import express from 'express';

/**
 * Regression test for #637: the full and hackathon apps previously returned
 * different JSON shapes for unknown routes (one went through the
 * `NotFoundError` → error-handler path, the other used a bespoke
 * `{ error, path }` body from a duplicate 404 middleware file). Both apps
 * now share the same `notFoundHandler`, so unknown-route responses should
 * carry an identical set of keys.
 */
describe('404 response parity across entrypoints', () => {
  let fullApp: express.Express;
  let hackathonApp: express.Express;

  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    fullApp = require('../index').createApp();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    hackathonApp = require('../app').createApp();
  });

  it('returns the same response keys for an unknown route on both apps', async () => {
    const fullRes = await request(fullApp).get('/api/this-route-does-not-exist');
    const hackathonRes = await request(hackathonApp).get('/api/this-route-does-not-exist');

    expect(fullRes.status).toBe(404);
    expect(hackathonRes.status).toBe(404);

    expect(Object.keys(fullRes.body).sort()).toEqual(
      Object.keys(hackathonRes.body).sort(),
    );
    expect(fullRes.body.error).toBe(hackathonRes.body.error);
    expect(fullRes.body.code).toBe(hackathonRes.body.code);
    expect(fullRes.body.path).toBe(hackathonRes.body.path);
  });
});
