-- Add resolution tracking fields to Prediction and Round models

-- Add won and payout fields to Prediction
ALTER TABLE "Prediction" ADD COLUMN "won" BOOLEAN;
ALTER TABLE "Prediction" ADD COLUMN "payout" NUMERIC(18,8);

-- Add resolvedAt field to Round
ALTER TABLE "Round" ADD COLUMN "resolvedAt" TIMESTAMP(3);

-- Add Soroban and pool fields to Round for game logic
ALTER TABLE "Round" ADD COLUMN "sorobanRoundId" TEXT;
ALTER TABLE "Round" ADD COLUMN "poolUp" NUMERIC(18,8) DEFAULT 0;
ALTER TABLE "Round" ADD COLUMN "poolDown" NUMERIC(18,8) DEFAULT 0;
ALTER TABLE "Round" ADD COLUMN "priceRanges" JSONB;

