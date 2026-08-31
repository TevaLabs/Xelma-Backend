import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockMessageCreate = jest.fn();
const mockMessageFindMany = jest.fn();
const mockMessageCount = jest.fn();

jest.mock('../lib/prisma', () => ({
  prisma: {
    message: {
      create: (...args: any[]) => mockMessageCreate(...args),
      findMany: (...args: any[]) => mockMessageFindMany(...args),
      count: (...args: any[]) => mockMessageCount(...args),
    },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockEmitChatMessage = jest.fn();
jest.mock('../services/websocket.service', () => ({
  __esModule: true,
  default: {
    emitChatMessage: (...args: any[]) => mockEmitChatMessage(...args),
  },
}));

import chatService from '../services/chat.service';
import { encodeCursor } from '../utils/pagination.util';

const USER_ID = 'user-123';
const WALLET_ADDRESS = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

describe('ChatService — unit tests & XSS regression coverage (Issue #526)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('sendMessage — Core flow & formatting', () => {
    it('creates message in database, masks wallet, and emits via websocket', async () => {
      const dbRow = {
        id: 'msg-abc',
        userId: USER_ID,
        content: 'Hello everyone!',
        createdAt: new Date('2026-08-28T12:00:00.000Z'),
        user: { walletAddress: WALLET_ADDRESS },
      };
      mockMessageCreate.mockResolvedValue(dbRow);

      const result = await chatService.sendMessage(USER_ID, WALLET_ADDRESS, '  Hello    everyone!  ');

      expect(mockMessageCreate).toHaveBeenCalledWith({
        data: {
          userId: USER_ID,
          content: 'Hello everyone!',
        },
        include: {
          user: {
            select: {
              walletAddress: true,
            },
          },
        },
      });

      expect(mockEmitChatMessage).toHaveBeenCalledTimes(1);
      expect(mockEmitChatMessage).toHaveBeenCalledWith({
        id: 'msg-abc',
        userId: USER_ID,
        walletAddress: 'GBRPYH...OX2H',
        content: 'Hello everyone!',
        createdAt: '2026-08-28T12:00:00.000Z',
      });

      expect(result).toEqual({
        id: 'msg-abc',
        userId: USER_ID,
        walletAddress: 'GBRPYH...OX2H',
        content: 'Hello everyone!',
        createdAt: '2026-08-28T12:00:00.000Z',
      });
    });

    it('keeps short wallet addresses as-is (<= 12 chars)', async () => {
      const shortWallet = 'G1234567890';
      mockMessageCreate.mockResolvedValue({
        id: 'msg-short',
        userId: USER_ID,
        content: 'Test',
        createdAt: new Date('2026-08-28T12:00:00.000Z'),
        user: { walletAddress: shortWallet },
      });

      const result = await chatService.sendMessage(USER_ID, shortWallet, 'Test');
      expect(result.walletAddress).toBe(shortWallet);
    });
  });

  describe('sendMessage — Content validation & length constraints', () => {
    it('rejects messages longer than 500 characters', async () => {
      const longContent = 'a '.repeat(251); // > 500 chars
      await expect(
        chatService.sendMessage(USER_ID, WALLET_ADDRESS, longContent),
      ).rejects.toThrow(/exceeds maximum length of 500/);

      expect(mockMessageCreate).not.toHaveBeenCalled();
      expect(mockEmitChatMessage).not.toHaveBeenCalled();
    });

    it('rejects empty or whitespace-only messages', async () => {
      await expect(
        chatService.sendMessage(USER_ID, WALLET_ADDRESS, '   '),
      ).rejects.toThrow(/empty or whitespace-only/);

      await expect(
        chatService.sendMessage(USER_ID, WALLET_ADDRESS, ''),
      ).rejects.toThrow();

      expect(mockMessageCreate).not.toHaveBeenCalled();
    });
  });

  describe('sendMessage — XSS regression & sanitization', () => {
    it('escapes standard <script> tags and quotes', async () => {
      const xssPayload = '<script>alert("xss")</script>';
      mockMessageCreate.mockImplementation(({ data }: any) =>
        Promise.resolve({
          id: 'msg-xss-1',
          userId: USER_ID,
          content: data.content,
          createdAt: new Date('2026-08-28T12:00:00.000Z'),
          user: { walletAddress: WALLET_ADDRESS },
        }),
      );

      const result = await chatService.sendMessage(USER_ID, WALLET_ADDRESS, xssPayload);

      expect(result.content).not.toContain('<script>');
      expect(result.content).not.toContain('</script>');
      expect(result.content).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;&#x2F;script&gt;');
    });

    it('strips inline on* event handlers and escapes img/svg tags', async () => {
      const imgPayload = '<img src="x" onerror="alert(1)">';
      mockMessageCreate.mockImplementation(({ data }: any) =>
        Promise.resolve({
          id: 'msg-xss-2',
          userId: USER_ID,
          content: data.content,
          createdAt: new Date('2026-08-28T12:00:00.000Z'),
          user: { walletAddress: WALLET_ADDRESS },
        }),
      );

      const result = await chatService.sendMessage(USER_ID, WALLET_ADDRESS, imgPayload);

      expect(result.content).not.toContain('onerror');
      expect(result.content).not.toContain('<img');
      expect(result.content).toContain('&lt;img');
    });

    it('sanitizes href javascript: and nested html entities', async () => {
      const linkPayload = '<a href="javascript:alert(1)">Click me</a>';
      mockMessageCreate.mockImplementation(({ data }: any) =>
        Promise.resolve({
          id: 'msg-xss-3',
          userId: USER_ID,
          content: data.content,
          createdAt: new Date('2026-08-28T12:00:00.000Z'),
          user: { walletAddress: WALLET_ADDRESS },
        }),
      );

      const result = await chatService.sendMessage(USER_ID, WALLET_ADDRESS, linkPayload);

      expect(result.content).not.toContain('<a');
      expect(result.content).not.toContain('</a>');
      expect(result.content).toBe('&lt;a href=&quot;javascript:alert(1)&quot;&gt;Click me&lt;&#x2F;a&gt;');
    });

    it('rejects suspicious injection patterns like SQL injection or excessive repetition', async () => {
      const sqlInjection = 'SELECT * FROM users WHERE id = 1;';
      await expect(
        chatService.sendMessage(USER_ID, WALLET_ADDRESS, sqlInjection),
      ).rejects.toThrow(/suspicious patterns/);

      const repeatedSpam = 'aaaaaa hello';
      await expect(
        chatService.sendMessage(USER_ID, WALLET_ADDRESS, repeatedSpam),
      ).rejects.toThrow(/suspicious patterns/);

      expect(mockMessageCreate).not.toHaveBeenCalled();
    });
  });

  describe('sendMessage — Profanity filter', () => {
    it('replaces blacklisted profanities with asterisks case-insensitively', async () => {
      const rudeMessage = 'This shit is damn crazy, what the fuck!';
      mockMessageCreate.mockImplementation(({ data }: any) =>
        Promise.resolve({
          id: 'msg-profane',
          userId: USER_ID,
          content: data.content,
          createdAt: new Date('2026-08-28T12:00:00.000Z'),
          user: { walletAddress: WALLET_ADDRESS },
        }),
      );

      const result = await chatService.sendMessage(USER_ID, WALLET_ADDRESS, rudeMessage);

      expect(result.content).toBe('This **** is **** crazy, what the ****!');
      expect(result.content).not.toMatch(/shit|damn|fuck/i);
    });
  });

  describe('getHistory — Legacy retrieval', () => {
    it('fetches messages, reverses to oldest-first, and masks wallets', async () => {
      const dbRows = [
        {
          id: 'msg-2',
          userId: 'user-2',
          content: 'Second message',
          createdAt: new Date('2026-08-28T12:05:00.000Z'),
          user: { walletAddress: WALLET_ADDRESS },
        },
        {
          id: 'msg-1',
          userId: 'user-1',
          content: 'First message',
          createdAt: new Date('2026-08-28T12:00:00.000Z'),
          user: { walletAddress: WALLET_ADDRESS },
        },
      ];
      mockMessageFindMany.mockResolvedValue(dbRows);

      const result = await chatService.getHistory(10);

      expect(mockMessageFindMany).toHaveBeenCalledWith({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { walletAddress: true } } },
      });

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('msg-1');
      expect(result[1].id).toBe('msg-2');
      expect(result[0].walletAddress).toBe('GBRPYH...OX2H');
    });
  });

  describe('getHistoryOffset — Offset pagination', () => {
    it('returns structured OffsetPage with reversed rows and pagination meta', async () => {
      const dbRows = [
        {
          id: 'msg-2',
          userId: 'user-2',
          content: 'Second',
          createdAt: new Date('2026-08-28T12:05:00.000Z'),
          user: { walletAddress: WALLET_ADDRESS },
        },
        {
          id: 'msg-1',
          userId: 'user-1',
          content: 'First',
          createdAt: new Date('2026-08-28T12:00:00.000Z'),
          user: { walletAddress: WALLET_ADDRESS },
        },
      ];
      mockMessageFindMany.mockResolvedValue(dbRows);
      mockMessageCount.mockResolvedValue(15);

      const result = await chatService.getHistoryOffset(2, 0);

      expect(result.data).toHaveLength(2);
      expect(result.data[0].id).toBe('msg-1');
      expect(result.data[1].id).toBe('msg-2');
      expect(result.pagination).toEqual({
        limit: 2,
        offset: 0,
        total: 15,
        hasNextPage: true,
      });
    });
  });

  describe('getHistoryCursor — Cursor pagination', () => {
    it('queries with sentinel limit+1, decodes cursor, and builds cursor metadata', async () => {
      const rows = [
        {
          id: 'msg-3',
          userId: 'user-3',
          content: 'Three',
          createdAt: new Date('2026-08-28T12:10:00.000Z'),
          user: { walletAddress: WALLET_ADDRESS },
        },
        {
          id: 'msg-2',
          userId: 'user-2',
          content: 'Two',
          createdAt: new Date('2026-08-28T12:05:00.000Z'),
          user: { walletAddress: WALLET_ADDRESS },
        },
        {
          id: 'msg-1',
          userId: 'user-1',
          content: 'One',
          createdAt: new Date('2026-08-28T12:00:00.000Z'),
          user: { walletAddress: WALLET_ADDRESS },
        },
      ];
      mockMessageFindMany.mockResolvedValue(rows);

      const cursor = encodeCursor({ createdAt: '2026-08-28T12:15:00.000Z', id: 'msg-4' });
      const result = await chatService.getHistoryCursor(2, cursor);

      expect(mockMessageFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 3,
          cursor: { id: 'msg-4' },
          skip: 1,
        }),
      );

      // Sentinel trimmed, so 2 items returned, reversed to oldest-first
      expect(result.data).toHaveLength(2);
      expect(result.data[0].id).toBe('msg-2');
      expect(result.data[1].id).toBe('msg-3');
      expect(result.pagination.hasNextPage).toBe(true);
      expect(typeof result.pagination.nextCursor).toBe('string');
    });
  });
});
