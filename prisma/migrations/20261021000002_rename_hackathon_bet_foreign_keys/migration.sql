-- ============================================================
-- Migration: 20261021000002_rename_hackathon_bet_foreign_keys
-- Description: Rename the hackathon_bets foreign keys to the names Prisma
--              generates, so the mock hackathon relations declared in
--              prisma/schema.prisma (MockBet -> MockRound / MockLeaderboard)
--              match the physical constraints exactly.
--
-- The constraints themselves are unchanged — only their identifiers move.
-- Prisma derives the canonical name from the model and field
-- ("<table>_<column>_fkey"), and a name mismatch shows up as drift in
-- `prisma migrate diff`.
--
-- Apply  : prisma migrate deploy
-- Rollback:
--   ALTER TABLE "hackathon_bets" RENAME CONSTRAINT "hackathon_bets_round_id_fkey" TO "hackathon_bets_round_id_fk";
--   ALTER TABLE "hackathon_bets" RENAME CONSTRAINT "hackathon_bets_address_fkey" TO "hackathon_bets_address_fk";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261021000002_rename_hackathon_bet_foreign_keys';
--
-- Risk: Low
--   * Renaming a constraint does not lock or rewrite the table for long and
--     keeps every existing row valid.
-- ============================================================

-- RenameForeignKey
ALTER TABLE "hackathon_bets" RENAME CONSTRAINT "hackathon_bets_round_id_fk" TO "hackathon_bets_round_id_fkey";

-- RenameForeignKey
ALTER TABLE "hackathon_bets" RENAME CONSTRAINT "hackathon_bets_address_fk" TO "hackathon_bets_address_fkey";
