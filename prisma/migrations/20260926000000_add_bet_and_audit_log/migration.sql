-- Migration: add_bet_and_audit_log
--
-- The `Bet` and `AuditLog` models were added to prisma/schema.prisma but no
-- migration ever created their backing tables, so a fresh database provisioned
-- with `prisma migrate deploy` (e.g. CI) was missing them and every integration
-- test that touched bets or the auth audit trail failed with
-- `The table public.Bet does not exist` / a missing AuditLog relation.
--
-- The BET_* values on the OutboxEventType enum were likewise declared in the
-- schema without a migration, so on-chain bet lifecycle events could not be
-- written. This migration closes that drift.
--
-- Pre-existing hackathon_* schema drift is intentionally left untouched; those
-- tables are registered by an earlier hand-written migration.

-- 1. New enum values for the on-chain bet outbox lifecycle.
ALTER TYPE "OutboxEventType" ADD VALUE IF NOT EXISTS 'BET_ACCEPTED';
ALTER TYPE "OutboxEventType" ADD VALUE IF NOT EXISTS 'BET_CONFIRMED';
ALTER TYPE "OutboxEventType" ADD VALUE IF NOT EXISTS 'BET_RESOLVED';
ALTER TYPE "OutboxEventType" ADD VALUE IF NOT EXISTS 'BET_FAILED';

-- 2. Bet enums.
CREATE TYPE "BetStatus" AS ENUM ('ACCEPTED', 'SUBMITTED', 'CONFIRMED', 'RESOLVED', 'FAILED');
CREATE TYPE "BetMode" AS ENUM ('UP_DOWN', 'PRECISION');

-- 3. Bet table.
CREATE TABLE "Bet" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "roundId" TEXT,
  "mode" "BetMode" NOT NULL,
  "side" "PredictionSide",
  "amount" DECIMAL(20,8) NOT NULL,
  "predictedPrice" DECIMAL(18,8),
  "status" "BetStatus" NOT NULL DEFAULT 'ACCEPTED',
  "txHash" TEXT,
  "failureReason" TEXT,
  "submittedAt" TIMESTAMP(3),
  "confirmedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Bet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Bet_txHash_key" ON "Bet"("txHash");
CREATE INDEX "Bet_userId_idx" ON "Bet"("userId");
CREATE INDEX "Bet_roundId_idx" ON "Bet"("roundId");
CREATE INDEX "Bet_status_idx" ON "Bet"("status");
CREATE INDEX "Bet_txHash_idx" ON "Bet"("txHash");
CREATE INDEX "Bet_createdAt_idx" ON "Bet"("createdAt");

ALTER TABLE "Bet" ADD CONSTRAINT "Bet_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Bet" ADD CONSTRAINT "Bet_roundId_fkey"
  FOREIGN KEY ("roundId") REFERENCES "Round"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. AuditLog table.
CREATE TABLE "AuditLog" (
  "id" TEXT NOT NULL,
  "eventType" VARCHAR(100) NOT NULL,
  "severity" VARCHAR(20) NOT NULL,
  "message" VARCHAR(500) NOT NULL,
  "outcome" VARCHAR(20) NOT NULL,
  "actorType" VARCHAR(50) NOT NULL,
  "walletAddress" VARCHAR(100),
  "userId" VARCHAR(100),
  "ipAddress" VARCHAR(45),
  "userAgent" VARCHAR(500),
  "requestId" VARCHAR(100),
  "sessionId" VARCHAR(100),
  "endpoint" VARCHAR(200),
  "method" VARCHAR(10),
  "resourceType" VARCHAR(50),
  "resourceId" VARCHAR(100),
  "resourceWalletAddress" VARCHAR(100),
  "metadata" JSONB,
  "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditLog_eventType_idx" ON "AuditLog"("eventType");
CREATE INDEX "AuditLog_severity_idx" ON "AuditLog"("severity");
CREATE INDEX "AuditLog_timestamp_idx" ON "AuditLog"("timestamp");
CREATE INDEX "AuditLog_walletAddress_idx" ON "AuditLog"("walletAddress");
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");
CREATE INDEX "AuditLog_outcome_idx" ON "AuditLog"("outcome");
