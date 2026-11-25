-- Add composite index on Prediction(roundId, createdAt) to speed up round prediction list queries.

-- CreateIndex
CREATE INDEX "Prediction_roundId_createdAt_idx" ON "Prediction"("roundId", "createdAt");
