-- Performance: Add indexes for tournament list queries
--
-- Tournament list queries in TournamentService.listFromPrisma filter optionally by
-- status and mode, and order by startTime DESC with pagination (skip/take):
--   WHERE [status = ?] [AND mode = ?] ORDER BY startTime DESC
--
-- Without composite indexes, list queries with status/mode filters and startTime ordering
-- perform full table scans or bitmap heap scans with sort operations.
--
-- Execution Plan note:
-- - Unfiltered list query: Index Scan Backward on "Tournament_startTime_idx"
-- - Status filtered list query: Bitmap Index Scan on "Tournament_status_startTime_idx"
-- - Mode filtered list query: Bitmap Index Scan on "Tournament_mode_startTime_idx"
-- - Status + Mode filtered list query: Index Scan on "Tournament_status_mode_startTime_idx"

-- CreateIndex
CREATE INDEX "Tournament_startTime_idx" ON "Tournament"("startTime" DESC);

-- CreateIndex
CREATE INDEX "Tournament_status_startTime_idx" ON "Tournament"("status", "startTime" DESC);

-- CreateIndex
CREATE INDEX "Tournament_mode_startTime_idx" ON "Tournament"("mode", "startTime" DESC);

-- CreateIndex
CREATE INDEX "Tournament_status_mode_startTime_idx" ON "Tournament"("status", "mode", "startTime" DESC);
