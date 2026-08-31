-- Hackathon mock-data tables were previously created by Drizzle ORM.
-- With Drizzle removed, create them here so a fresh database (e.g. CI)
-- has the tables required by the Prisma MockRound/MockLeaderboard/MockBet
-- and MockPlatformStat models.
-- See: https://github.com/TevaLabs/Xelma-Backend/issues/509

CREATE TABLE IF NOT EXISTS "hackathon_rounds" (
  "id" text PRIMARY KEY NOT NULL,
  "asset" text NOT NULL,
  "mode" text NOT NULL,
  "status" text NOT NULL,
  "start_price" double precision NOT NULL,
  "pool_up" double precision,
  "pool_down" double precision,
  "total_pool" double precision,
  "prediction_count" integer,
  "closes_at" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "hackathon_users" (
  "address" text PRIMARY KEY NOT NULL,
  "rank" integer NOT NULL DEFAULT 0,
  "balance" integer DEFAULT 1000 NOT NULL,
  "pending_winnings" integer DEFAULT 0 NOT NULL,
  "total_wins" integer DEFAULT 3 NOT NULL,
  "total_losses" integer DEFAULT 1 NOT NULL,
  "current_streak" integer DEFAULT 3 NOT NULL,
  "xp" integer DEFAULT 410 NOT NULL,
  "rank_title" text DEFAULT 'Rookie' NOT NULL
);

CREATE TABLE IF NOT EXISTS "hackathon_bets" (
  "id" serial PRIMARY KEY NOT NULL,
  "round_id" text NOT NULL,
  "address" text NOT NULL,
  "amount" double precision NOT NULL,
  "side" text,
  "predicted_price" double precision,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "hackathon_bets_round_id_fk" FOREIGN KEY ("round_id")
    REFERENCES "hackathon_rounds"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "hackathon_bets_address_fk" FOREIGN KEY ("address")
    REFERENCES "hackathon_users"("address") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TABLE IF NOT EXISTS "MockPlatformStat" (
  "id" integer PRIMARY KEY NOT NULL DEFAULT 1,
  "totalRounds" integer NOT NULL,
  "totalVxlmDistributed" double precision NOT NULL,
  "activePlayers" integer NOT NULL,
  "totalBetsPlaced" integer NOT NULL
);
