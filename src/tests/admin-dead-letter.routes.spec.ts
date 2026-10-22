import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockAbandon = jest.fn<any>();
const mockRetry = jest.fn<any>();
const mockRetryAll = jest.fn<any>();
const mockList = jest.fn<any>();

jest.mock('../services/dead-letter-queue.service', () => ({
  __esModule: true,
  default: {
    abandon: (...args: any[]) => mockAbandon(...args),
    retry: (...args: any[]) => mockRetry(...args),
    retryAll: (...args: any[]) => mockRetryAll(...args),
    list: (...args: any[]) => mockList(...args),
  },
  deadLetterQueueService: {
    abandon: (...args: any[]) => mockAbandon(...args),
    retry: (...args: any[]) => mockRetry(...args),
    retryAll: (...args: any[]) => mockRetryAll(...args),
    list: (...args: any[]) => mockList(...args),
  },
}));

const mockLogDlqAbandoned = jest.fn();
jest.mock('../utils/audit-logger', () => ({
  __esModule: true,
  default: {
    logDlqAbandoned: (...args: any[]) => mockLogDlqAbandoned(...args),
    log: jest.fn(),
  },
  auditLogger: {
    logDlqAbandoned: (...args: any[]) => mockLogDlqAbandoned(...args),
    log: jest.fn(),
  },
}));

let mockUser: any = { userId: 'admin-1', walletAddress: 'GADMIN123', role: 'ADMIN' };
jest.mock('../middleware/auth.middleware', () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    if (!mockUser) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (mockUser.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.user = mockUser;
    next();
  },
}));

import router from '../routes/admin-dead-letter.routes';

const app = express();
app.use(express.json());
app.use('/api/admin/dead-letter', router);

describe('Admin Dead Letter Routes - Abandon & Retry Workflow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { userId: 'admin-1', walletAddress: 'GADMIN123', role: 'ADMIN' };
  });

  describe('Authorization', () => {
    it('rejects unauthenticated requests with 401', async () => {
      mockUser = null;
      const res = await request(app)
        .post('/api/admin/dead-letter/dlq-123/abandon')
        .send({ reason: 'Corrupt payload' });
      expect(res.status).toBe(401);
    });

    it('rejects non-admin users with 403', async () => {
      mockUser = { userId: 'user-1', role: 'USER' };
      const res = await request(app)
        .post('/api/admin/dead-letter/dlq-123/abandon')
        .send({ reason: 'Corrupt payload' });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/admin/dead-letter/:id/abandon', () => {
    it('returns 400 when reason is missing', async () => {
      const res = await request(app)
        .post('/api/admin/dead-letter/dlq-123/abandon')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('reason is required');
      expect(mockAbandon).not.toHaveBeenCalled();
    });

    it('returns 400 when reason is only whitespace', async () => {
      const res = await request(app)
        .post('/api/admin/dead-letter/dlq-123/abandon')
        .send({ reason: '   ' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('reason is required');
      expect(mockAbandon).not.toHaveBeenCalled();
    });

    it('returns 404 when entry does not exist in DLQ', async () => {
      mockAbandon.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/admin/dead-letter/dlq-not-found/abandon')
        .send({ reason: 'Stale notification' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Dead-letter entry not found');
      expect(mockLogDlqAbandoned).not.toHaveBeenCalled();
    });

    it('successfully abandons DLQ entry, logs audit event, and returns abandoned record', async () => {
      mockAbandon.mockResolvedValue({
        id: 'dlq-123',
        channel: 'WEBSOCKET_EMIT',
        eventName: 'notification:new',
        userId: 'target-user-1',
        status: 'ABANDONED',
        attempts: 2,
        lastError: '[ABANDONED] Invalid schema version',
      });

      const res = await request(app)
        .post('/api/admin/dead-letter/dlq-123/abandon')
        .send({ reason: 'Invalid schema version' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: 'dlq-123',
        status: 'ABANDONED',
        attempts: 2,
        lastError: '[ABANDONED] Invalid schema version',
      });
      expect(mockAbandon).toHaveBeenCalledWith('dlq-123', 'Invalid schema version');
      expect(mockLogDlqAbandoned).toHaveBeenCalledWith(
        expect.objectContaining({
          dlqId: 'dlq-123',
          channel: 'WEBSOCKET_EMIT',
          eventName: 'notification:new',
          userId: 'target-user-1',
          reason: 'Invalid schema version',
          actorUserId: 'admin-1',
          actorWalletAddress: 'GADMIN123',
        }),
      );
    });

    it('returns 500 when service throws an unexpected error', async () => {
      mockAbandon.mockRejectedValue(new Error('Database disk full'));

      const res = await request(app)
        .post('/api/admin/dead-letter/dlq-err/abandon')
        .send({ reason: 'Some reason' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to abandon dead-letter entry');
    });
  });

  describe('POST /api/admin/dead-letter/:id/retry', () => {
    it('returns 404 when entry does not exist', async () => {
      mockRetry.mockResolvedValue(null);
      const res = await request(app)
        .post('/api/admin/dead-letter/dlq-999/retry')
        .send({});
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Dead-letter entry not found');
    });

    it('returns retry result on success', async () => {
      mockRetry.mockResolvedValue({
        id: 'dlq-999',
        status: 'RESOLVED',
        attempts: 2,
      });
      const res = await request(app)
        .post('/api/admin/dead-letter/dlq-999/retry')
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: 'dlq-999',
        status: 'RESOLVED',
        attempts: 2,
      });
    });
  });

  describe('GET /api/admin/dead-letter', () => {
    it('returns paginated DLQ entries', async () => {
      mockList.mockResolvedValue({
        entries: [{ id: 'dlq-1' }],
        total: 1,
        limit: 50,
        offset: 0,
      });
      const res = await request(app).get('/api/admin/dead-letter');
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.entries).toHaveLength(1);
    });
  });
});
