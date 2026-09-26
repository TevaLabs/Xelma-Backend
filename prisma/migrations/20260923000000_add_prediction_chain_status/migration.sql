-- Migration: add_prediction_chain_status
-- Adds the PredictionChainStatus enum and chain-tracking fields to the
-- Prediction table.  Safely backfills historical rows so they never
-- appear as PENDING.

-- 1. Create the enum type.
CREATE TYPE "PredictionChainStatus" AS ENUM (
  'NOT_REQUIRED',
  'PENDING',
  'SUBMITTED',
  'CONFIRMED',
  'FAILED',
  'NEEDS_MANUAL_REVIEW'
);

-- 2. Add new columns with safe defaults.
--    chainStatus defaults to PENDING (matches schema default for new rows).
ALTER TABLE "Prediction"
  ADD COLUMN "chainStatus" "PredictionChainStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "txHash" TEXT,
  ADD COLUMN "chainAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "chainFailureReason" TEXT,
  ADD COLUMN "chainSubmittedAt" TIMESTAMP(3),
  ADD COLUMN "chainConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "chainFailedAt" TIMESTAMP(3),
  ADD COLUMN "compensatedAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- 3. Backfill historical rows.
--    Every existing prediction was accepted successfully, so:
--      - UP_DOWN predictions (have a non-null side) → CONFIRMED
--      - LEGENDS predictions (have priceRange, side is null) → NOT_REQUIRED
--    This uses the Round.mode to distinguish, joined via roundId.
UPDATE "Prediction" p
SET "chainStatus" = CASE
  WHEN r."mode" = 'LEGENDS' THEN 'NOT_REQUIRED'::"PredictionChainStatus"
  ELSE 'CONFIRMED'::"PredictionChainStatus"
END,
"chainConfirmedAt" = CASE
  WHEN r."mode" != 'LEGENDS' THEN p."createdAt"
  ELSE NULL
END
FROM "Round" r
WHERE p."roundId" = r."id";

-- 4. Unique index on txHash (allows nulls, unique where not null).
CREATE UNIQUE INDEX "Prediction_txHash_key" ON "Prediction"("txHash");

-- 5. Index for reconciliation queries.
CREATE INDEX "Prediction_chainStatus_idx" ON "Prediction"("chainStatus");

