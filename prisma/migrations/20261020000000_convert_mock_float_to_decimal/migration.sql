-- Convert Mock* Float monetary columns to Decimal(20,8) for precision-safe math
-- This migration addresses issue #621: MockRound, MockBet, and MockPlatformStat
-- had Float columns that could drift from production Decimal(20,8) values.

-- MockRound: startPrice, poolUp, poolDown, totalPool
ALTER TABLE "hackathon_rounds" ALTER COLUMN "start_price" SET DATA TYPE DECIMAL(20, 8);
ALTER TABLE "hackathon_rounds" ALTER COLUMN "pool_up" SET DATA TYPE DECIMAL(20, 8);
ALTER TABLE "hackathon_rounds" ALTER COLUMN "pool_down" SET DATA TYPE DECIMAL(20, 8);
ALTER TABLE "hackathon_rounds" ALTER COLUMN "total_pool" SET DATA TYPE DECIMAL(20, 8);

-- MockBet: amount, predicted_price
ALTER TABLE "hackathon_bets" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(20, 8);
ALTER TABLE "hackathon_bets" ALTER COLUMN "predicted_price" SET DATA TYPE DECIMAL(20, 8);

-- MockPlatformStat: totalVxlmDistributed
ALTER TABLE "MockPlatformStat" ALTER COLUMN "totalVxlmDistributed" SET DATA TYPE DECIMAL(20, 8);

-- MockLeaderboard: balances are money too. They were integer columns, which
-- silently truncated fractional XLM amounts when mock bets were placed.
ALTER TABLE "hackathon_users" ALTER COLUMN "balance" SET DATA TYPE DECIMAL(20, 8) USING "balance"::numeric;
ALTER TABLE "hackathon_users" ALTER COLUMN "balance" SET DEFAULT 1000;
ALTER TABLE "hackathon_users" ALTER COLUMN "pending_winnings" SET DATA TYPE DECIMAL(20, 8) USING "pending_winnings"::numeric;
ALTER TABLE "hackathon_users" ALTER COLUMN "pending_winnings" SET DEFAULT 0;

-- Reverse (down) migration notes:
--   ALTER TABLE "hackathon_rounds" ALTER COLUMN "start_price" SET DATA TYPE double precision;
--   ... (same shape for every column above; converting back to float loses precision)
--   ALTER TABLE "hackathon_users" ALTER COLUMN "balance" SET DATA TYPE integer USING round("balance")::integer;
