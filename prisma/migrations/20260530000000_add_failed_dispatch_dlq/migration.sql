-- CreateEnum
CREATE TYPE "DispatchChannel" AS ENUM ('NOTIFICATION_CREATE', 'WEBSOCKET_EMIT');

-- CreateEnum
CREATE TYPE "DispatchStatus" AS ENUM ('PENDING', 'RETRYING', 'RESOLVED', 'ABANDONED');

-- CreateTable
CREATE TABLE "FailedDispatch" (
    "id" TEXT NOT NULL,
    "channel" "DispatchChannel" NOT NULL,
    "eventName" TEXT,
    "userId" TEXT,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "status" "DispatchStatus" NOT NULL DEFAULT 'PENDING',
    "lastError" VARCHAR(1000) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastRetryAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "FailedDispatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FailedDispatch_channel_idx" ON "FailedDispatch"("channel");

-- CreateIndex
CREATE INDEX "FailedDispatch_status_idx" ON "FailedDispatch"("status");

-- CreateIndex
CREATE INDEX "FailedDispatch_createdAt_idx" ON "FailedDispatch"("createdAt");

-- CreateIndex
CREATE INDEX "FailedDispatch_userId_idx" ON "FailedDispatch"("userId");
