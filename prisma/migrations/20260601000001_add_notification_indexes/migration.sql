-- Add composite indexes on Notification to support efficient cursor-based
-- pagination and the unreadOnly filter path.
--
-- (userId, createdAt)        → ORDER BY createdAt DESC WHERE userId = ?
-- (userId, isRead, createdAt) → ORDER BY createdAt DESC WHERE userId = ? AND isRead = false

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_createdAt_idx" ON "Notification"("userId", "isRead", "createdAt");
