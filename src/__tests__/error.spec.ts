import request from 'supertest';
import app from '../app';

describe('Global App Error Infrastructure', () => {
  it('should return a structured JSON 404 response on unknown routes', async () => {
    const response = await request(app)
      .get('/api/v1/completely-unknown-route-endpoint')
      .expect('Content-Type', /json/)
      .expect(404);

    expect(response.body).toEqual({
      error: 'Not Found',
      path: '/api/v1/completely-unknown-route-endpoint',
    });
  });

  it('should format execution exceptions as a standardized structured JSON 4xx/5xx payload', async () => {
    const response = await request(app)
      .get('/test-error')
      .expect('Content-Type', /json/)
      .expect(400);

    expect(response.body).toHaveProperty('error', 'Explicitly triggered test exception handler pass-through');
    expect(response.body).toHaveProperty('path', '/test-error');
  });
});