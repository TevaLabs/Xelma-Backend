import express from 'express';
import request from 'supertest';
import app from '../app';
import { errorHandler } from '../middleware/errorHandler.middleware';
import { ValidationError } from '../utils/errors';

/**
 * Global error infrastructure: both the 404 handler and the centralized error
 * handler emit the standard error envelope documented as BaseErrorResponse
 * (`error` = error class name, `message` = human-readable text, `code`, `path`).
 */
describe('Global App Error Infrastructure', () => {
  it('should return a structured JSON 404 response on unknown routes', async () => {
    const response = await request(app)
      .get('/api/v1/completely-unknown-route-endpoint')
      .expect('Content-Type', /json/)
      .expect(404);

    expect(response.body).toMatchObject({
      error: 'NotFoundError',
      message: 'Route GET /api/v1/completely-unknown-route-endpoint not found',
      code: 'NOT_FOUND',
      path: '/api/v1/completely-unknown-route-endpoint',
    });
    expect(response.body.timestamp).toBeDefined();
  });

  it('should format execution exceptions as a standardized structured JSON 4xx/5xx payload', async () => {
    const throwingApp = express();
    throwingApp.get('/test-error', () => {
      throw new ValidationError('Explicitly triggered test exception handler pass-through');
    });
    throwingApp.use(errorHandler);

    const response = await request(throwingApp)
      .get('/test-error')
      .expect('Content-Type', /json/)
      .expect(400);

    expect(response.body).toMatchObject({
      error: 'ValidationError',
      message: 'Explicitly triggered test exception handler pass-through',
      code: 'VALIDATION_ERROR',
      path: '/test-error',
    });
  });
});
