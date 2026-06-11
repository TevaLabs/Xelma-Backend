/**
 * Notifications routes and ownership tests (Issue #78).
 * Uses mocked Prisma so tests pass without DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { UserRole } from "@prisma/client";
import { createApp } from "../index";
import { generateToken } from "../utils/jwt.util";

const USER_A_ID = "notif-user-a-id";
const USER_B_ID = "notif-user-b-id";
const NOTIF_A_ID = "notif-a-id";
const NOTIF_B_ID = "notif-b-id";

const mockUserFindUnique = jest.fn();
const mockNotificationFindMany = jest.fn();
const mockNotificationCount = jest.fn();
const mockNotificationFindUnique = jest.fn();
const mockNotificationCreate = jest.fn();
const mockNotificationUpdate = jest.fn();
const mockNotificationUpdateMany = jest.fn();
const mockNotificationDelete = jest.fn();
const mockNotificationDeleteMany = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: (...args: any[]) => mockUserFindUnique(...args),
    },
    notification: {
      findMany: (...args: any[]) => mockNotificationFindMany(...args),
      count: (...args: any[]) => mockNotificationCount(...args),
      findUnique: (...args: any[]) => mockNotificationFindUnique(...args),
      create: (...args: any[]) => mockNotificationCreate(...args),
      update: (...args: any[]) => mockNotificationUpdate(...args),
      updateMany: (...args: any[]) => mockNotificationUpdateMany(...args),
      delete: (...args: any[]) => mockNotificationDelete(...args),
      deleteMany: (...args: any[]) => mockNotificationDeleteMany(...args),
    },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

describe("Notifications Routes & Ownership (Issue #78)", () => {
  let app: Express;
  let userA: { id: string; walletAddress: string };
  let userB: { id: string; walletAddress: string };
  let tokenA: string;
  let tokenB: string;
  let notificationOwnedByA: string;
  let notificationOwnedByB: string;
  let notifAList: any[];
  let notifBList: any[];

  beforeAll(async () => {
    app = createApp();

    userA = { id: USER_A_ID, walletAddress: "GNOTIF_USER_A_____________________________" };
    userB = { id: USER_B_ID, walletAddress: "GNOTIF_USER_B_____________________________" };
    tokenA = generateToken(userA.id, userA.walletAddress, UserRole.USER);
    tokenB = generateToken(userB.id, userB.walletAddress, UserRole.USER);
    notificationOwnedByA = NOTIF_A_ID;
    notificationOwnedByB = NOTIF_B_ID;

    notifAList = [
      {
        id: NOTIF_A_ID,
        userId: userA.id,
        type: "WIN",
        title: "Win",
        message: "You won",
        isRead: false,
        data: null,
        createdAt: new Date(),
      },
    ];
    notifBList = [
      {
        id: NOTIF_B_ID,
        userId: userB.id,
        type: "LOSS",
        title: "Loss",
        message: "You lost",
        isRead: false,
        data: null,
        createdAt: new Date(),
      },
    ];

    mockUserFindUnique.mockImplementation((args: any) => {
      if (args?.where?.id === userA.id)
        return Promise.resolve({ id: userA.id, walletAddress: userA.walletAddress, role: "USER" });
      if (args?.where?.id === userB.id)
        return Promise.resolve({ id: userB.id, walletAddress: userB.walletAddress, role: "USER" });
      return Promise.resolve(null);
    });

    mockNotificationFindMany.mockImplementation((args: any) => {
      if (args?.where?.userId === userA.id) return Promise.resolve(notifAList);
      if (args?.where?.userId === userB.id) return Promise.resolve(notifBList);
      return Promise.resolve([]);
    });

    mockNotificationCount.mockImplementation((args: any) => {
      if (args?.where?.userId === userA.id)
        return Promise.resolve(notifAList.filter((n) => !n.isRead).length);
      if (args?.where?.userId === userB.id)
        return Promise.resolve(notifBList.filter((n) => !n.isRead).length);
      return Promise.resolve(0);
    });

    mockNotificationFindUnique.mockImplementation((args: any) => {
      if (args?.where?.id === NOTIF_A_ID) return Promise.resolve(notifAList[0]);
      if (args?.where?.id === NOTIF_B_ID) return Promise.resolve(notifBList[0]);
      return Promise.resolve(null);
    });

    mockNotificationUpdate.mockResolvedValue({ id: NOTIF_A_ID, isRead: true });
    mockNotificationUpdateMany.mockResolvedValue({ count: 1 });
    mockNotificationDelete.mockResolvedValue({});
    mockNotificationDeleteMany.mockResolvedValue({ count: 0 });
  });

  beforeEach(() => {
    notifAList[0].isRead = false;
    notifBList[0].isRead = false;
  });

  afterAll(() => {
    jest.clearAllMocks();
  });

  describe("GET /api/notifications", () => {
    it("should return 401 without auth", async () => {
      const res = await request(app).get("/api/notifications");
      expect(res.status).toBe(401);
    });

    it("should return 200 with notifications for authenticated user", async () => {
      const res = await request(app)
        .get("/api/notifications")
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.notifications).toBeDefined();
      expect(Array.isArray(res.body.notifications)).toBe(true);
      expect(res.body.notifications.some((n: any) => n.id === notificationOwnedByA)).toBe(true);
    });

    it("should respect limit and offset query params", async () => {
      const res = await request(app)
        .get("/api/notifications?limit=1&offset=0")
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(1);
      expect(res.body.offset).toBe(0);
      expect(res.body.notifications.length).toBeLessThanOrEqual(1);
    });
  });

  describe("GET /api/notifications/unread-count", () => {
    it("should return 401 without auth", async () => {
      const res = await request(app).get("/api/notifications/unread-count");
      expect(res.status).toBe(401);
    });

    it("should return unread count for authenticated user", async () => {
      const res = await request(app)
        .get("/api/notifications/unread-count")
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.unreadCount).toBe("number");
    });
  });

  describe("GET /api/notifications/:id - ownership", () => {
    it("should return 200 when user owns the notification", async () => {
      const res = await request(app)
        .get(`/api/notifications/${notificationOwnedByA}`)
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.notification.id).toBe(notificationOwnedByA);
    });

    it("should return 404 when user does not own the notification (ownership check)", async () => {
      const res = await request(app)
        .get(`/api/notifications/${notificationOwnedByB}`)
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(404);
      expect(res.body.message).toContain("not found");
    });

    it("should return 401 without auth", async () => {
      const res = await request(app).get(`/api/notifications/${notificationOwnedByA}`);
      expect(res.status).toBe(401);
    });
  });

  describe("PATCH /api/notifications/:id/read - ownership", () => {
    it("should return 200 and mark as read when user owns the notification", async () => {
      const readNotifId = "read-me-id";
      mockNotificationFindUnique.mockResolvedValueOnce({
        id: readNotifId,
        userId: userA.id,
        isRead: false,
      });
      mockNotificationUpdate.mockResolvedValueOnce({ id: readNotifId, isRead: true });

      const res = await request(app)
        .patch(`/api/notifications/${readNotifId}/read`)
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("should return 404 when user does not own the notification", async () => {
      const res = await request(app)
        .patch(`/api/notifications/${notificationOwnedByB}/read`)
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(404);
      expect(res.body.message).toContain("not found");
    });
  });

  describe("PATCH /api/notifications/read-all", () => {
    it("should return 401 without auth", async () => {
      const res = await request(app).patch("/api/notifications/read-all");
      expect(res.status).toBe(401);
    });

    it("should return 200 and markedCount for authenticated user", async () => {
      const res = await request(app)
        .patch("/api/notifications/read-all")
        .set("Authorization", `Bearer ${tokenB}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.markedCount).toBe("number");
    });
  });

  describe("DELETE /api/notifications/:id - ownership", () => {
    it("should return 404 when user does not own the notification", async () => {
      const res = await request(app)
        .delete(`/api/notifications/${notificationOwnedByA}`)
        .set("Authorization", `Bearer ${tokenB}`);

      expect(res.status).toBe(404);
      expect(res.body.message).toContain("not found");
    });

    it("should return 200 and delete when user owns the notification", async () => {
      const deleteNotifId = "delete-me-id";
      mockNotificationFindUnique.mockResolvedValueOnce({
        id: deleteNotifId,
        userId: userA.id,
      });
      mockNotificationDelete.mockResolvedValueOnce({});

      const res = await request(app)
        .delete(`/api/notifications/${deleteNotifId}`)
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("should return 401 without auth", async () => {
      const res = await request(app).delete(`/api/notifications/${notificationOwnedByA}`);
      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /api/notifications (delete all read)", () => {
    it("should return 401 without auth", async () => {
      const res = await request(app).delete("/api/notifications");
      expect(res.status).toBe(401);
    });

    it("should return 200 with deletedCount for authenticated user", async () => {
      const res = await request(app)
        .delete("/api/notifications")
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.deletedCount).toBe("number");
    });
  });

  // -------------------------------------------------------------------------
  // Pagination contract tests (Issue #19)
  // -------------------------------------------------------------------------

  describe("GET /api/notifications – pagination contracts", () => {
    it("offset mode: response includes pagination meta with total, limit, offset", async () => {
      const res = await request(app)
        .get("/api/notifications?limit=10&offset=0")
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.limit).toBe(10);
      expect(res.body.pagination.offset).toBe(0);
      expect(typeof res.body.pagination.total).toBe("number");
      expect(typeof res.body.pagination.hasNextPage).toBe("boolean");
      // Legacy fields still present for backward compatibility
      expect(typeof res.body.total).toBe("number");
      expect(typeof res.body.limit).toBe("number");
      expect(typeof res.body.offset).toBe("number");
    });

    it("offset mode: hasNextPage is false when all results fit on one page", async () => {
      // notifAList has 1 item; limit=10 → no next page
      const res = await request(app)
        .get("/api/notifications?limit=10&offset=0")
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.pagination.hasNextPage).toBe(false);
    });

    it("returns 400 for limit=0", async () => {
      const res = await request(app)
        .get("/api/notifications?limit=0")
        .set("Authorization", `Bearer ${tokenA}`);
      expect(res.status).toBe(400);
    });

    it("returns 400 for limit > 100", async () => {
      const res = await request(app)
        .get("/api/notifications?limit=101")
        .set("Authorization", `Bearer ${tokenA}`);
      expect(res.status).toBe(400);
    });

    it("returns 400 for negative offset", async () => {
      const res = await request(app)
        .get("/api/notifications?offset=-1")
        .set("Authorization", `Bearer ${tokenA}`);
      expect(res.status).toBe(400);
    });

    it("cursor mode: returns pagination.nextCursor and hasNextPage", async () => {
      // Return limit+1 rows to trigger hasNextPage=true
      const manyNotifs = Array.from({ length: 6 }, (_, i) => ({
        id: `cursor-notif-${i}`,
        userId: USER_A_ID,
        type: "WIN",
        title: "Win",
        message: "You won",
        isRead: false,
        data: null,
        createdAt: new Date(Date.now() - i * 1000),
      }));
      mockNotificationFindMany.mockResolvedValueOnce(manyNotifs);

      const { encodeCursor } = await import("../utils/pagination.util");
      const cursor = encodeCursor({ createdAt: new Date().toISOString(), id: "some-id" });

      const res = await request(app)
        .get(`/api/notifications?limit=5&cursor=${cursor}`)
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.hasNextPage).toBe(true);
      expect(typeof res.body.pagination.nextCursor).toBe("string");
      // No offset/total in cursor mode
      expect(res.body.pagination.total).toBeUndefined();
      expect(res.body.pagination.offset).toBeUndefined();
    });

    it("cursor mode: nextCursor is null on the last page", async () => {
      // Return fewer rows than limit → last page
      mockNotificationFindMany.mockResolvedValueOnce(notifAList);

      const { encodeCursor } = await import("../utils/pagination.util");
      const cursor = encodeCursor({ createdAt: new Date().toISOString(), id: "some-id" });

      const res = await request(app)
        .get(`/api/notifications?limit=10&cursor=${cursor}`)
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.pagination.hasNextPage).toBe(false);
      expect(res.body.pagination.nextCursor).toBeNull();
    });

    it("cursor mode: offset is ignored when cursor is present", async () => {
      mockNotificationFindMany.mockResolvedValueOnce(notifAList);

      const { encodeCursor } = await import("../utils/pagination.util");
      const cursor = encodeCursor({ createdAt: new Date().toISOString(), id: "some-id" });

      const res = await request(app)
        .get(`/api/notifications?limit=10&cursor=${cursor}&offset=99`)
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      // Cursor mode response has no offset field
      expect(res.body.pagination.offset).toBeUndefined();
    });
  });
});
