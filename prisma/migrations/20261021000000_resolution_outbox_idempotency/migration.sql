-- Keep one logical outbox event for each resolution prediction and channel.
ALTER TABLE "OutboxEvent"
ADD COLUMN "dedupeKey" TEXT;

CREATE UNIQUE INDEX "OutboxEvent_aggregateType_aggregateId_eventType_dedupeKey_key"
ON "OutboxEvent"("aggregateType", "aggregateId", "eventType", "dedupeKey");

-- Link notifications created by the outbox to their source event so a
-- delivery retry after an ambiguous failure cannot create a second row.
ALTER TABLE "Notification"
ADD COLUMN "outboxEventId" TEXT;

CREATE UNIQUE INDEX "Notification_outboxEventId_key"
ON "Notification"("outboxEventId");
