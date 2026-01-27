-- CreateEnum
CREATE TYPE "GameMode" AS ENUM ('UP_DOWN', 'LEGENDS');

-- CreateEnum
CREATE TYPE "RoundStatus" AS ENUM ('PENDING', 'ACTIVE', 'LOCKED', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PredictionSide" AS ENUM ('UP', 'DOWN');

-- CreateTable
CREATE TABLE "Round" (
    "id" TEXT NOT NULL,
    "mode" "GameMode" NOT NULL,
    "status" "RoundStatus" NOT NULL DEFAULT 'PENDING',
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "startPrice" DOUBLE PRECISION NOT NULL,
    "endPrice" DOUBLE PRECISION,
    "sorobanRoundId" TEXT,
    "poolUp" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "poolDown" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priceRanges" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Round_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prediction" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "side" "PredictionSide",
    "priceRange" JSONB,
    "won" BOOLEAN,
    "payout" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Prediction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Round_sorobanRoundId_key" ON "Round"("sorobanRoundId");

-- CreateIndex
CREATE INDEX "Round_status_idx" ON "Round"("status");

-- CreateIndex
CREATE INDEX "Round_mode_idx" ON "Round"("mode");

-- CreateIndex
CREATE INDEX "Round_startTime_idx" ON "Round"("startTime");

-- CreateIndex
CREATE INDEX "Prediction_userId_idx" ON "Prediction"("userId");

-- CreateIndex
CREATE INDEX "Prediction_roundId_idx" ON "Prediction"("roundId");

-- CreateIndex
CREATE UNIQUE INDEX "Prediction_roundId_userId_key" ON "Prediction"("roundId", "userId");

-- AddForeignKey
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "Round"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
