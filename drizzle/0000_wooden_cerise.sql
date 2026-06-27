CREATE TABLE "hackathon_bets" (
	"id" serial PRIMARY KEY NOT NULL,
	"round_id" text NOT NULL,
	"address" text NOT NULL,
	"amount" double precision NOT NULL,
	"side" text,
	"predicted_price" double precision,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hackathon_rounds" (
	"id" text PRIMARY KEY NOT NULL,
	"asset" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"start_price" double precision NOT NULL,
	"pool_up" double precision DEFAULT 0 NOT NULL,
	"pool_down" double precision DEFAULT 0 NOT NULL,
	"total_pool" double precision DEFAULT 0 NOT NULL,
	"prediction_count" integer DEFAULT 0 NOT NULL,
	"closes_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hackathon_users" (
	"address" text PRIMARY KEY NOT NULL,
	"balance" integer DEFAULT 1000 NOT NULL,
	"pending_winnings" integer DEFAULT 0 NOT NULL,
	"total_wins" integer DEFAULT 3 NOT NULL,
	"total_losses" integer DEFAULT 1 NOT NULL,
	"current_streak" integer DEFAULT 3 NOT NULL,
	"xp" integer DEFAULT 410 NOT NULL,
	"rank_title" text DEFAULT 'Rookie' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hackathon_bets" ADD CONSTRAINT "hackathon_bets_round_id_hackathon_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."hackathon_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hackathon_bets" ADD CONSTRAINT "hackathon_bets_address_hackathon_users_address_fk" FOREIGN KEY ("address") REFERENCES "public"."hackathon_users"("address") ON DELETE cascade ON UPDATE no action;