-- CreateTable (Issue #990): optional durable BetAuditEvent store.
CREATE TABLE "BetAuditEvent" (
    "id" TEXT NOT NULL,
    "event" VARCHAR(50) NOT NULL,
    "roundId" TEXT,
    "betId" TEXT,
    "address" TEXT NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "side" VARCHAR(10),
    "mode" VARCHAR(20),
    "result" VARCHAR(100) NOT NULL,
    "status" VARCHAR(50),
    "txHash" VARCHAR(200),
    "requestId" VARCHAR(100),
    "correlationId" VARCHAR(200),
    "failureReason" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BetAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BetAuditEvent_event_createdAt_idx" ON "BetAuditEvent"("event", "createdAt");

-- CreateIndex
CREATE INDEX "BetAuditEvent_address_createdAt_idx" ON "BetAuditEvent"("address", "createdAt");

-- CreateIndex
CREATE INDEX "BetAuditEvent_roundId_idx" ON "BetAuditEvent"("roundId");

-- CreateIndex
CREATE INDEX "BetAuditEvent_betId_idx" ON "BetAuditEvent"("betId");

-- CreateIndex
CREATE INDEX "BetAuditEvent_txHash_idx" ON "BetAuditEvent"("txHash");
