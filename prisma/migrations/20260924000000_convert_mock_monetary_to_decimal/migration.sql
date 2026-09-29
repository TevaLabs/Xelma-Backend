-- ============================================================
-- Migration: 20260924000000_convert_mock_monetary_to_decimal
-- Description: Convert the hackathon "Mock*" monetary columns from
--   double precision / integer to DECIMAL(20, 8) so mock-mode money
--   storage uses the same precision contract as production
--   (issue #621).
--
-- Apply  : prisma migrate deploy
-- Rollback: revert each column to its previous type and clear the
--   migration record (`prisma migrate reset` is destructive — do NOT
--   use it on a populated database):
--
--   ALTER TABLE "hackathon_rounds" ALTER COLUMN "start_price" SET DATA TYPE double precision;
--   ALTER TABLE "hackathon_rounds" ALTER COLUMN "pool_up" SET DATA TYPE double precision;
--   ALTER TABLE "hackathon_rounds" ALTER COLUMN "pool_down" SET DATA TYPE double precision;
--   ALTER TABLE "hackathon_rounds" ALTER COLUMN "total_pool" SET DATA TYPE double precision;
--   ALTER TABLE "hackathon_bets" ALTER COLUMN "amount" SET DATA TYPE double precision;
--   ALTER TABLE "hackathon_bets" ALTER COLUMN "predicted_price" SET DATA TYPE double precision;
--   ALTER TABLE "hackathon_users" ALTER COLUMN "balance" SET DATA TYPE integer;
--   ALTER TABLE "hackathon_users" ALTER COLUMN "balance" SET DEFAULT 1000;
--   ALTER TABLE "hackathon_users" ALTER COLUMN "pending_winnings" SET DATA TYPE integer;
--   ALTER TABLE "hackathon_users" ALTER COLUMN "pending_winnings" SET DEFAULT 0;
--   ALTER TABLE "MockPlatformStat" ALTER COLUMN "totalVxlmDistributed" SET DATA TYPE double precision;
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260924000000_convert_mock_monetary_to_decimal';
-- ============================================================

-- MockRound (hackathon_rounds): prices and pools are money.
ALTER TABLE "hackathon_rounds" ALTER COLUMN "start_price" SET DATA TYPE DECIMAL(20, 8);
ALTER TABLE "hackathon_rounds" ALTER COLUMN "pool_up" SET DATA TYPE DECIMAL(20, 8);
ALTER TABLE "hackathon_rounds" ALTER COLUMN "pool_down" SET DATA TYPE DECIMAL(20, 8);
ALTER TABLE "hackathon_rounds" ALTER COLUMN "total_pool" SET DATA TYPE DECIMAL(20, 8);

-- MockBet (hackathon_bets): stake and predicted price are money.
ALTER TABLE "hackathon_bets" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(20, 8);
ALTER TABLE "hackathon_bets" ALTER COLUMN "predicted_price" SET DATA TYPE DECIMAL(20, 8);

-- MockLeaderboard (hackathon_users): balance and pending winnings are money.
ALTER TABLE "hackathon_users" ALTER COLUMN "balance" SET DATA TYPE DECIMAL(20, 8);
ALTER TABLE "hackathon_users" ALTER COLUMN "balance" SET DEFAULT 1000;
ALTER TABLE "hackathon_users" ALTER COLUMN "pending_winnings" SET DATA TYPE DECIMAL(20, 8);
ALTER TABLE "hackathon_users" ALTER COLUMN "pending_winnings" SET DEFAULT 0;

-- MockPlatformStat: distributed VXLM is money.
ALTER TABLE "MockPlatformStat" ALTER COLUMN "totalVxlmDistributed" SET DATA TYPE DECIMAL(20, 8);
