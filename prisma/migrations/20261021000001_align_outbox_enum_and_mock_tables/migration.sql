-- ============================================================
-- Migration: 20261021000001_align_outbox_enum_and_mock_tables
-- Description: Reconcile the remaining prisma/schema.prisma drift — the
--              bet-lifecycle values of the "OutboxEventType" enum and the
--              mock hackathon table definitions.
--
-- The "Bet" lifecycle outbox events (BET_ACCEPTED / BET_CONFIRMED /
-- BET_RESOLVED / BET_FAILED) are written by bet.service but were missing
-- from the database enum, so every outbox write failed with
--   "invalid input value for enum \"OutboxEventType\": \"BET_ACCEPTED\"".
--
-- The mock hackathon tables (hackathon_rounds / hackathon_users /
-- hackathon_bets) were registered with snake_case defaults and a
-- "timestamp" (without precision) column that the Prisma models do not
-- declare; the statements below align the physical tables with
-- prisma/schema.prisma. The foreign keys on hackathon_bets are kept — they
-- are declared as relations in the schema and guarantee that a mock bet can
-- never reference a missing round or wallet.
--
-- Apply  : prisma migrate deploy
-- Rollback:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261021000001_align_outbox_enum_and_mock_tables';
--   (Enum values cannot be removed in PostgreSQL.)
--
-- Risk: Low
--   * Enum values are additive only; existing rows are unaffected.
--   * The default removals only affect inserts that omit those columns; the
--     application always writes them explicitly.
-- ============================================================

-- AlterEnum
ALTER TYPE "OutboxEventType" ADD VALUE IF NOT EXISTS 'BET_ACCEPTED';
ALTER TYPE "OutboxEventType" ADD VALUE IF NOT EXISTS 'BET_CONFIRMED';
ALTER TYPE "OutboxEventType" ADD VALUE IF NOT EXISTS 'BET_RESOLVED';
ALTER TYPE "OutboxEventType" ADD VALUE IF NOT EXISTS 'BET_FAILED';

-- AlterTable
ALTER TABLE "hackathon_bets" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "hackathon_users" ALTER COLUMN "rank" DROP DEFAULT,
ALTER COLUMN "total_wins" DROP DEFAULT,
ALTER COLUMN "total_losses" DROP DEFAULT,
ALTER COLUMN "current_streak" DROP DEFAULT,
ALTER COLUMN "xp" DROP DEFAULT,
ALTER COLUMN "rank_title" DROP DEFAULT;
