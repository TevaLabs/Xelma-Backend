-- AlterTable: earliest time a failed outbox row may be retried (Issue #713).
-- Null means the row is eligible immediately.
ALTER TABLE "OutboxEvent" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);

-- CreateIndex: the poller selects due rows by (status, nextAttemptAt).
CREATE INDEX "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent"("status", "nextAttemptAt");
