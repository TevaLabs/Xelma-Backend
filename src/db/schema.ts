import { pgTable, text, integer, doublePrecision, timestamp, serial } from 'drizzle-orm/pg-core';

export const hackathonUsers = pgTable('hackathon_users', {
  address: text('address').primaryKey(),
  balance: integer('balance').default(1000).notNull(),
  pendingWinnings: integer('pending_winnings').default(0).notNull(),
  totalWins: integer('total_wins').default(3).notNull(),
  totalLosses: integer('total_losses').default(1).notNull(),
  currentStreak: integer('current_streak').default(3).notNull(),
  xp: integer('xp').default(410).notNull(),
  rankTitle: text('rank_title').default('Rookie').notNull(),
});

export const hackathonRounds = pgTable('hackathon_rounds', {
  id: text('id').primaryKey(),
  asset: text('asset').notNull(),
  mode: text('mode').$type<'updown' | 'precision'>().notNull(),
  status: text('status').$type<'live' | 'new'>().notNull(),
  startPrice: doublePrecision('start_price').notNull(),
  poolUp: doublePrecision('pool_up').default(0).notNull(),
  poolDown: doublePrecision('pool_down').default(0).notNull(),
  totalPool: doublePrecision('total_pool').default(0).notNull(),
  predictionCount: integer('prediction_count').default(0).notNull(),
  closesAt: text('closes_at').notNull(),
});

export const hackathonBets = pgTable('hackathon_bets', {
  id: serial('id').primaryKey(),
  roundId: text('round_id').references(() => hackathonRounds.id, { onDelete: 'cascade' }).notNull(),
  address: text('address').references(() => hackathonUsers.address, { onDelete: 'cascade' }).notNull(),
  amount: doublePrecision('amount').notNull(),
  side: text('side').$type<'UP' | 'DOWN'>(),
  predictedPrice: doublePrecision('predicted_price'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
