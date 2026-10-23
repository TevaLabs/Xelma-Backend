-- Migration: add_bet_audit_event
-- Issue #835 — optional Prisma persistence for bet-audit events.
--
-- Rows are only written when BET_AUDIT_STORAGE=database. With the default
-- (memory) the table stays empty and the service keeps events in process
-- memory; if a database write fails the service falls back to memory and
-- logs the failure, so this table is safe to create before the flag is
-- flipped anywhere.
--
-- Self-contained on purpose: no foreign keys and no enum types, so it can
-- be applied to any database that has the earlier migrations (the BetMode /
-- BetStatus enum types are not part of the migration history yet).

-- CreateTable
CREATE TABLE "BetAuditEvent" (
    "id" TEXT NOT NULL,
    "event" VARCHAR(40) NOT NULL,
    "roundId" TEXT,
    "betId" TEXT,
    "address" VARCHAR(100) NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "side" VARCHAR(8),
    "mode" VARCHAR(20),
    "result" VARCHAR(100) NOT NULL,
    "status" VARCHAR(20),
    "txHash" TEXT,
    "requestId" VARCHAR(100),
    "correlationId" VARCHAR(200),
    "failureReason" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BetAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BetAuditEvent_createdAt_idx" ON "BetAuditEvent"("createdAt");

-- CreateIndex
CREATE INDEX "BetAuditEvent_event_createdAt_idx" ON "BetAuditEvent"("event", "createdAt");

-- CreateIndex
CREATE INDEX "BetAuditEvent_address_createdAt_idx" ON "BetAuditEvent"("address", "createdAt");

-- CreateIndex
CREATE INDEX "BetAuditEvent_txHash_idx" ON "BetAuditEvent"("txHash");

-- CreateIndex
CREATE INDEX "BetAuditEvent_betId_idx" ON "BetAuditEvent"("betId");
