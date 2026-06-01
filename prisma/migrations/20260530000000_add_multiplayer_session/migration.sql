-- CreateTable
CREATE TABLE "MultiplayerSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "socketId" TEXT,
    "rooms" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),

    CONSTRAINT "MultiplayerSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MultiplayerSession_userId_key" ON "MultiplayerSession"("userId");

-- CreateIndex
CREATE INDEX "MultiplayerSession_walletAddress_idx" ON "MultiplayerSession"("walletAddress");

-- CreateIndex
CREATE INDEX "MultiplayerSession_lastSeenAt_idx" ON "MultiplayerSession"("lastSeenAt");

-- AddForeignKey
ALTER TABLE "MultiplayerSession" ADD CONSTRAINT "MultiplayerSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
