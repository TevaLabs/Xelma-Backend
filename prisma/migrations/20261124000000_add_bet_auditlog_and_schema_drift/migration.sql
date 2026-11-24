-- Brings the migration history back in line with prisma/schema.prisma.
--
-- These models/values were added to the schema without a migration, so a
-- database built with `prisma migrate deploy` (CI, fresh environments) was
-- missing them: the Bet and AuditLog tables, the BetStatus/BetMode enums, the
-- BET_* OutboxEventType values, and the unique index on User.nickname that the
-- nickname-conflict handling (P2002 -> 409) relies on.
--
-- Deliberately NOT included: the hackathon_* differences `prisma migrate diff`
-- reports. Those tables carry hand-written foreign keys and defaults that the
-- Prisma schema does not model, and "fixing" the drift would drop them.
--
-- Deploy note: the unique index on "User"."nickname" fails if duplicate
-- non-null nicknames already exist. Check first with:
--   SELECT nickname, count(*) FROM "User"
--   WHERE nickname IS NOT NULL GROUP BY nickname HAVING count(*) > 1;

-- CreateEnum
CREATE TYPE "BetStatus" AS ENUM ('ACCEPTED', 'SUBMITTED', 'CONFIRMED', 'RESOLVED', 'FAILED');

-- CreateEnum
CREATE TYPE "BetMode" AS ENUM ('UP_DOWN', 'PRECISION');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OutboxEventType" ADD VALUE 'BET_ACCEPTED';
ALTER TYPE "OutboxEventType" ADD VALUE 'BET_CONFIRMED';
ALTER TYPE "OutboxEventType" ADD VALUE 'BET_RESOLVED';
ALTER TYPE "OutboxEventType" ADD VALUE 'BET_FAILED';

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
CREATE UNIQUE INDEX "Bet_txHash_key" ON "Bet"("txHash");

-- CreateIndex
CREATE INDEX "Bet_userId_idx" ON "Bet"("userId");

-- CreateIndex
CREATE INDEX "Bet_roundId_idx" ON "Bet"("roundId");

-- CreateIndex
CREATE INDEX "Bet_status_idx" ON "Bet"("status");

-- CreateIndex
CREATE INDEX "Bet_txHash_idx" ON "Bet"("txHash");

-- CreateIndex
CREATE INDEX "Bet_createdAt_idx" ON "Bet"("createdAt");

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

-- CreateIndex
CREATE UNIQUE INDEX "User_nickname_key" ON "User"("nickname");

-- AddForeignKey
ALTER TABLE "Bet" ADD CONSTRAINT "Bet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bet" ADD CONSTRAINT "Bet_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "Round"("id") ON DELETE SET NULL ON UPDATE CASCADE;
