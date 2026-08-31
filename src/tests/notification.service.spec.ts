import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { DispatchChannel } from '@prisma/client';

const mockUserFindUnique = jest.fn();
const mockNotificationCreate = jest.fn();
const mockNotificationFindMany = jest.fn();
const mockNotificationCount = jest.fn();
const mockNotificationFindUnique = jest.fn();
const mockNotificationUpdate = jest.fn();
const mockNotificationUpdateMany = jest.fn();
const mockNotificationDelete = jest.fn();
const mockNotificationDeleteMany = jest.fn();

jest.mock('../lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (...args: any[]) => mockUserFindUnique(...args),
    },
    notification: {
      create: (...args: any[]) => mockNotificationCreate(...args),
      findMany: (...args: any[]) => mockNotificationFindMany(...args),
      count: (...args: any[]) => mockNotificationCount(...args),
      findUnique: (...args: any[]) => mockNotificationFindUnique(...args),
      update: (...args: any[]) => mockNotificationUpdate(...args),
      updateMany: (...args: any[]) => mockNotificationUpdateMany(...args),
      delete: (...args: any[]) => mockNotificationDelete(...args),
      deleteMany: (...args: any[]) => mockNotificationDeleteMany(...args),
    },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockDlqRecord = jest.fn();
jest.mock('../services/dead-letter-queue.service', () => ({
  __esModule: true,
  default: {
    record: (...args: any[]) => mockDlqRecord(...args),
  },
}));

import notificationService from '../services/notification.service';
import { encodeCursor } from '../utils/pagination.util';

const USER_ID = 'user-test-id';
const OTHER_USER_ID = 'user-other-id';
const NOTIF_ID = 'notif-test-id';

describe('NotificationService — unit tests (Issue #527)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Preference filters & creation (createNotification)', () => {
    it('creates notification when user has no preferences set', async () => {
      mockUserFindUnique.mockResolvedValue({ id: USER_ID, notificationPreferences: null });
      mockNotificationCreate.mockResolvedValue({
        id: NOTIF_ID,
        userId: USER_ID,
        type: 'WIN',
        title: 'You Won!',
        message: 'Reward credited',
        data: null,
      });

      const result = await notificationService.createNotification({
        userId: USER_ID,
        type: 'WIN',
        title: 'You Won!',
        message: 'Reward credited',
      });

      expect(result).not.toBeNull();
      expect(result.id).toBe(NOTIF_ID);
      expect(mockNotificationCreate).toHaveBeenCalledWith({
        data: {
          userId: USER_ID,
          type: 'WIN',
          title: 'You Won!',
          message: 'Reward credited',
          data: null,
        },
      });
    });

    it('skips notification when user preference is explicitly false for type', async () => {
      mockUserFindUnique.mockResolvedValue({
        id: USER_ID,
        notificationPreferences: { win: false, loss: true, roundStart: false, bonus: false, announcement: false },
      });

      const winResult = await notificationService.createNotification({
        userId: USER_ID,
        type: 'WIN',
        title: 'Won',
        message: 'msg',
      });
      expect(winResult).toBeNull();
      expect(mockNotificationCreate).not.toHaveBeenCalled();

      const roundStartResult = await notificationService.createNotification({
        userId: USER_ID,
        type: 'ROUND_START',
        title: 'Round Started',
        message: 'msg',
      });
      expect(roundStartResult).toBeNull();

      const bonusResult = await notificationService.createNotification({
        userId: USER_ID,
        type: 'BONUS_AVAILABLE',
        title: 'Bonus',
        message: 'msg',
      });
      expect(bonusResult).toBeNull();

      const announcementResult = await notificationService.createNotification({
        userId: USER_ID,
        type: 'ANNOUNCEMENT',
        title: 'Announcement',
        message: 'msg',
      });
      expect(announcementResult).toBeNull();

      // LOSS is true, so should create
      mockNotificationCreate.mockResolvedValueOnce({ id: 'notif-loss', type: 'LOSS' });
      const lossResult = await notificationService.createNotification({
        userId: USER_ID,
        type: 'LOSS',
        title: 'Lost',
        message: 'msg',
      });
      expect(lossResult).not.toBeNull();
    });

    it('defaults to true if checking preferences encounters an error', async () => {
      mockUserFindUnique.mockRejectedValue(new Error('DB read error'));
      mockNotificationCreate.mockResolvedValue({
        id: NOTIF_ID,
        userId: USER_ID,
        type: 'WIN',
      });

      const result = await notificationService.createNotification({
        userId: USER_ID,
        type: 'WIN',
        title: 'You Won!',
        message: 'Reward credited',
      });

      expect(result).not.toBeNull();
      expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
    });

    it('records to dead-letter queue and rethrows when notification create fails', async () => {
      mockUserFindUnique.mockResolvedValue({ id: USER_ID, notificationPreferences: null });
      const dbError = new Error('DB write failure');
      mockNotificationCreate.mockRejectedValue(dbError);

      const input = {
        userId: USER_ID,
        type: 'WIN' as const,
        title: 'You Won!',
        message: 'Reward credited',
      };

      await expect(notificationService.createNotification(input)).rejects.toThrow(dbError);

      expect(mockDlqRecord).toHaveBeenCalledWith({
        channel: DispatchChannel.NOTIFICATION_CREATE,
        eventName: 'WIN',
        userId: USER_ID,
        payload: input,
        error: dbError,
      });
    });

    it('createNotificationForRetry skips preference check and creates record directly', async () => {
      mockNotificationCreate.mockResolvedValue({ id: 'retry-id', userId: USER_ID });

      const input = {
        userId: USER_ID,
        type: 'WIN' as const,
        title: 'Win',
        message: 'msg',
      };

      const result = await notificationService.createNotificationForRetry(input);
      expect(result.id).toBe('retry-id');
      expect(mockUserFindUnique).not.toHaveBeenCalled();
      expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('Pagination & querying', () => {
    const baseDate = new Date('2026-08-28T12:00:00.000Z');
    const mockRows = [
      {
        id: 'n-1',
        userId: USER_ID,
        type: 'WIN',
        title: 'Win 1',
        message: 'Msg 1',
        data: null,
        isRead: false,
        createdAt: baseDate,
      },
      {
        id: 'n-2',
        userId: USER_ID,
        type: 'LOSS',
        title: 'Loss 2',
        message: 'Msg 2',
        data: null,
        isRead: true,
        createdAt: new Date(baseDate.getTime() - 1000),
      },
    ];

    it('getUserNotifications (legacy) applies limit capping and unreadOnly filter', async () => {
      mockNotificationFindMany.mockResolvedValue(mockRows);
      mockNotificationCount.mockResolvedValue(2);

      const result = await notificationService.getUserNotifications(USER_ID, 200, 5, true);

      expect(mockNotificationFindMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, isRead: false },
        orderBy: { createdAt: 'desc' },
        skip: 5,
        take: 100, // Capped from 200 to 100
      });
      expect(result).toEqual({
        notifications: mockRows,
        total: 2,
        limit: 100,
        offset: 5,
      });
    });

    it('getUserNotificationsOffset returns formatted DTOs and pagination envelope', async () => {
      mockNotificationFindMany.mockResolvedValue(mockRows);
      mockNotificationCount.mockResolvedValue(10);

      const result = await notificationService.getUserNotificationsOffset(USER_ID, 2, 0, false);

      expect(result.data).toHaveLength(2);
      expect(result.data[0].createdAt).toBe(baseDate.toISOString());
      expect(result.pagination).toEqual({
        limit: 2,
        offset: 0,
        total: 10,
        hasNextPage: true,
      });
    });

    it('getUserNotificationsCursor decodes cursor and queries with sentinel limit+1', async () => {
      const rowsWithSentinel = [
        ...mockRows,
        {
          id: 'n-3',
          userId: USER_ID,
          type: 'BONUS_AVAILABLE',
          title: 'Bonus 3',
          message: 'Msg 3',
          data: null,
          isRead: false,
          createdAt: new Date(baseDate.getTime() - 2000),
        },
      ];
      mockNotificationFindMany.mockResolvedValue(rowsWithSentinel);

      const cursor = encodeCursor({ createdAt: baseDate.toISOString(), id: 'n-0' });
      const result = await notificationService.getUserNotificationsCursor(USER_ID, 2, cursor, true);

      expect(mockNotificationFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER_ID, isRead: false },
          take: 3,
          cursor: { id: 'n-0' },
          skip: 1,
        }),
      );

      // Sentinel trimmed
      expect(result.data).toHaveLength(2);
      expect(result.pagination.hasNextPage).toBe(true);
      expect(typeof result.pagination.nextCursor).toBe('string');
    });
  });

  describe('Read marking & deletion (markAsRead, markAllAsRead, deleteNotification, etc.)', () => {
    it('markAsRead returns null if notification does not exist or user mismatch', async () => {
      mockNotificationFindUnique.mockResolvedValueOnce(null);
      const notFoundResult = await notificationService.markAsRead(NOTIF_ID, USER_ID);
      expect(notFoundResult).toBeNull();

      mockNotificationFindUnique.mockResolvedValueOnce({ id: NOTIF_ID, userId: OTHER_USER_ID });
      const mismatchResult = await notificationService.markAsRead(NOTIF_ID, USER_ID);
      expect(mismatchResult).toBeNull();
      expect(mockNotificationUpdate).not.toHaveBeenCalled();
    });

    it('markAsRead updates isRead to true when user owns notification', async () => {
      mockNotificationFindUnique.mockResolvedValue({ id: NOTIF_ID, userId: USER_ID });
      mockNotificationUpdate.mockResolvedValue({ id: NOTIF_ID, isRead: true });

      const result = await notificationService.markAsRead(NOTIF_ID, USER_ID);
      expect(result).toEqual({ id: NOTIF_ID, isRead: true });
      expect(mockNotificationUpdate).toHaveBeenCalledWith({
        where: { id: NOTIF_ID },
        data: { isRead: true },
      });
    });

    it('markAllAsRead updates all unread notifications for the user', async () => {
      mockNotificationUpdateMany.mockResolvedValue({ count: 5 });

      const count = await notificationService.markAllAsRead(USER_ID);
      expect(count).toBe(5);
      expect(mockNotificationUpdateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, isRead: false },
        data: { isRead: true },
      });
    });

    it('deleteNotification deletes owned notification and returns true', async () => {
      mockNotificationFindUnique.mockResolvedValue({ id: NOTIF_ID, userId: USER_ID });
      mockNotificationDelete.mockResolvedValue({});

      const result = await notificationService.deleteNotification(NOTIF_ID, USER_ID);
      expect(result).toBe(true);
      expect(mockNotificationDelete).toHaveBeenCalledWith({
        where: { id: NOTIF_ID },
      });
    });

    it('deleteNotification returns false on missing record or ownership mismatch', async () => {
      mockNotificationFindUnique.mockResolvedValueOnce(null);
      expect(await notificationService.deleteNotification(NOTIF_ID, USER_ID)).toBe(false);

      mockNotificationFindUnique.mockResolvedValueOnce({ id: NOTIF_ID, userId: OTHER_USER_ID });
      expect(await notificationService.deleteNotification(NOTIF_ID, USER_ID)).toBe(false);
      expect(mockNotificationDelete).not.toHaveBeenCalled();
    });

    it('deleteAllRead deletes all read notifications for user', async () => {
      mockNotificationDeleteMany.mockResolvedValue({ count: 3 });

      const count = await notificationService.deleteAllRead(USER_ID);
      expect(count).toBe(3);
      expect(mockNotificationDeleteMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, isRead: true },
      });
    });

    it('cleanupOldNotifications deletes notifications older than specified days', async () => {
      mockNotificationDeleteMany.mockResolvedValue({ count: 12 });

      const count = await notificationService.cleanupOldNotifications(30);
      expect(count).toBe(12);
      expect(mockNotificationDeleteMany).toHaveBeenCalledWith({
        where: {
          createdAt: {
            lt: expect.any(Date),
          },
        },
      });
    });

    it('getNotification returns notification when owned, null otherwise', async () => {
      mockNotificationFindUnique.mockResolvedValueOnce(null);
      expect(await notificationService.getNotification(NOTIF_ID, USER_ID)).toBeNull();

      mockNotificationFindUnique.mockResolvedValueOnce({ id: NOTIF_ID, userId: OTHER_USER_ID });
      expect(await notificationService.getNotification(NOTIF_ID, USER_ID)).toBeNull();

      mockNotificationFindUnique.mockResolvedValueOnce({ id: NOTIF_ID, userId: USER_ID });
      const record = await notificationService.getNotification(NOTIF_ID, USER_ID);
      expect(record).toEqual({ id: NOTIF_ID, userId: USER_ID });
    });

    it('getUnreadCount returns count of unread notifications for user', async () => {
      mockNotificationCount.mockResolvedValue(7);

      const count = await notificationService.getUnreadCount(USER_ID);
      expect(count).toBe(7);
      expect(mockNotificationCount).toHaveBeenCalledWith({
        where: { userId: USER_ID, isRead: false },
      });
    });
  });
});
