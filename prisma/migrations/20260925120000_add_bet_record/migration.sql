-- Durable backing store for src/data/bet-store.ts (issue #624).
-- The store previously kept bets in a process-local Map, so a deploy, crash,
-- or second replica lost the demo audit trail. This table makes bets survive
-- process restarts whenever the postgres backend is selected
-- (DATA_STORE=postgres, the DATA_MODE=live default).

-- CreateTable
CREATE TABLE "BetRecord" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "mode" TEXT NOT NULL,
    "side" TEXT,
    "predictedPrice" DECIMAL(20,8),
    "roundId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'STUB',
    "txHash" TEXT,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BetRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BetRecord_address_createdAt_idx" ON "BetRecord"("address", "createdAt");

-- CreateIndex
CREATE INDEX "BetRecord_roundId_idx" ON "BetRecord"("roundId");

-- CreateIndex
CREATE INDEX "BetRecord_status_idx" ON "BetRecord"("status");
