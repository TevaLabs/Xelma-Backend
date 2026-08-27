-- ============================================================
-- Migration: 20260827000000_add_bet_record
-- Description: Durable bet-store table (Issue #519). Persists the
-- process-local bet store so bets survive restarts / multi-instance
-- deployments when DATA_STORE=postgres.
--
-- Apply  : prisma migrate deploy
-- Rollback:
--   DROP TABLE IF EXISTS "BetRecord";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260827000000_add_bet_record';
-- ============================================================

-- CreateTable
CREATE TABLE "BetRecord" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "side" TEXT,
    "predictedPrice" DECIMAL(18,8),
    "mode" TEXT NOT NULL,
    "roundId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "txHash" TEXT,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" VARCHAR(2000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BetRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BetRecord_address_idx" ON "BetRecord"("address");

-- CreateIndex
CREATE INDEX "BetRecord_roundId_idx" ON "BetRecord"("roundId");

-- CreateIndex
CREATE INDEX "BetRecord_status_idx" ON "BetRecord"("status");

-- CreateIndex
CREATE INDEX "BetRecord_timestamp_idx" ON "BetRecord"("timestamp");
