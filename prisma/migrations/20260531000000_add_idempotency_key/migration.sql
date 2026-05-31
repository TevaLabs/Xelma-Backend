-- CreateTable IdempotencyKey
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_userId_endpoint_idempotencyKey_key" ON "IdempotencyKey"("userId", "endpoint", "idempotencyKey");

-- CreateIndex
CREATE INDEX "IdempotencyKey_userId_idx" ON "IdempotencyKey"("userId");

-- CreateIndex
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");
