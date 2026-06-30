import request from 'supertest';
import { createApp } from '../index';
import logger from '../utils/logger';

describe('Request ID Tracing', () => {
  const app = createApp();
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(logger, 'info');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('requestIdMiddleware', () => {
    it('should generate a request ID for each request', async () => {
      const res = await request(app)
        .get('/')
        .expect(200);

      expect(res.headers['x-request-id']).toBeDefined();
      expect(typeof res.headers['x-request-id']).toBe('string');
      expect(res.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    it('should include request ID in response header', async () => {
      const res = await request(app).get('/');
      
      expect(res.headers).toHaveProperty('x-request-id');
      expect(res.headers['x-request-id']).toBeTruthy();
    });

    it('should use existing X-Request-ID header if provided', async () => {
      const customRequestId = '12345-custom-request-id';
      
      const res = await request(app)
        .get('/')
        .set('X-Request-ID', customRequestId)
        .expect(200);

      expect(res.headers['x-request-id']).toBe(customRequestId);
    });

    it('should propagate request ID through middleware chain', async () => {
      const res = await request(app).get('/health');
      
      expect(res.headers['x-request-id']).toBeDefined();
      
      // Verify the request ID is a valid UUID if auto-generated
      const requestId = res.headers['x-request-id'];
      expect(requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[a-zA-Z0-9\-]+$/i
      );
    });

    it('should include request ID in logs', async () => {
      await request(app).get('/').expect(200);

      // Check that logger was called with metadata containing requestId
      const logCalls = logSpy.mock.calls;
      expect(logCalls.length).toBeGreaterThan(0);
      
      // The logging middleware should log with requestId in metadata
      const hasRequestIdLog = logCalls.some((call) => {
        const message = call[0];
        const metadata = call[1];
        
        return (
          message.includes('GET /') &&
          metadata &&
          metadata.requestId &&
          typeof metadata.requestId === 'string'
        );
      });

      expect(hasRequestIdLog).toBe(true);
    });

    it('should generate unique request IDs for different requests', async () => {
      const res1 = await request(app).get('/').expect(200);
      const res2 = await request(app).get('/').expect(200);

      const requestId1 = res1.headers['x-request-id'];
      const requestId2 = res2.headers['x-request-id'];

      expect(requestId1).toBeDefined();
      expect(requestId2).toBeDefined();
      expect(requestId1).not.toBe(requestId2);
    });

    it('should include request ID for different route types', async () => {
      const routes = ['/', '/health', '/api-docs.json'];
      
      for (const route of routes) {
        const res = await request(app).get(route);
        
        expect(res.headers['x-request-id']).toBeDefined();
        expect(typeof res.headers['x-request-id']).toBe('string');
      }
    });

    it('should handle 404 errors with request ID', async () => {
      const res = await request(app)
        .get('/this-route-does-not-exist')
        .expect(404);

      expect(res.headers['x-request-id']).toBeDefined();
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('should handle multiple requests in parallel', async () => {
      const requests = Array.from({ length: 5 }, () =>
        request(app).get('/health')
      );

      const responses = await Promise.all(requests);
      const requestIds = responses.map(res => res.headers['x-request-id']);

      // All should have request IDs
      requestIds.forEach(id => {
        expect(id).toBeDefined();
        expect(typeof id).toBe('string');
      });

      // All should be unique
      const uniqueIds = new Set(requestIds);
      expect(uniqueIds.size).toBe(requestIds.length);
    });

    it('should allow request ID to be accessed in route handlers', async () => {
      // The health check route should be able to receive the request with ID attached
      const res = await request(app)
        .get('/health')
        .set('X-Request-ID', 'test-request-id-123')
        .expect(200);

      expect(res.headers['x-request-id']).toBe('test-request-id-123');
      expect(['healthy', 'degraded']).toContain(res.body.status);
    });
  });

  describe('Express Request extension', () => {
    it('should have requestId available in Express Request interface', async () => {
      // This tests that TypeScript compilation succeeds with the requestId property
      // The actual runtime test happens above when we check middleware functionality
      const res = await request(app)
        .get('/')
        .expect(200);

      // Verify the header is set (which proves requestId was available in middleware)
      expect(res.headers['x-request-id']).toBeDefined();
    });
  });
});
