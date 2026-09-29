-- Migration: add_bet_and_audit_log
-- The Bet and AuditLog models were declared in prisma/schema.prisma and used
-- throughout the application, but no migration ever provisioned them. Because
-- CI provisions the test database with `prisma migrate deploy` (which only
-- replays committed migrations and never diffs the schema), both tables were
-- absent and every code path that touched them failed at runtime with
-- `relation "public.Bet" does not exist`.
--
-- This migration creates the two missing enum types and both missing tables.

-- CreateEnum
CREATE TYPE "BetStatus" AS ENUM ('ACCEPTED', 'SUBMITTED', 'CONFIRMED', 'RESOLVED', 'FAILED');

-- CreateEnum
CREATE TYPE "BetMode" AS ENUM ('UP_DOWN', 'PRECISION');

-- CreateTable
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

-- CreateIndex
CREATE UNIQUE INDEX "Bet_txHash_key" ON "Bet"("txHash");

-- CreateIndex
CREATE INDEX "Bet_userId_idx" ON "Bet"("userId");

-- CreateIndex
CREATE INDEX "Bet_roundId_idx" ON "Bet"("roundId");

-- CreateIndex
CREATE INDEX "Bet_status_idx" ON "Bet"("status");

-- CreateIndex
CREATE INDEX "Bet_createdAt_idx" ON "Bet"("createdAt");

-- AddForeignKey
ALTER TABLE "Bet" ADD CONSTRAINT "Bet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bet" ADD CONSTRAINT "Bet_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "Round"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
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

-- CreateIndex
CREATE INDEX "AuditLog_eventType_idx" ON "AuditLog"("eventType");

-- CreateIndex
CREATE INDEX "AuditLog_severity_idx" ON "AuditLog"("severity");

-- CreateIndex
CREATE INDEX "AuditLog_timestamp_idx" ON "AuditLog"("timestamp");

-- CreateIndex
CREATE INDEX "AuditLog_walletAddress_idx" ON "AuditLog"("walletAddress");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_outcome_idx" ON "AuditLog"("outcome");
