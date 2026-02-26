-- Migrate monetary fields from Float to Decimal(20,8) for precision-safe math
-- and add resolvedAt timestamp to Round model

-- User.virtualBalance
ALTER TABLE "User" ALTER COLUMN "virtualBalance" SET DATA TYPE DECIMAL(20, 8);
ALTER TABLE "User" ALTER COLUMN "virtualBalance" SET DEFAULT 1000;

-- Round monetary fields
ALTER TABLE "Round" ALTER COLUMN "startPrice" SET DATA TYPE DECIMAL(20, 8);
ALTER TABLE "Round" ALTER COLUMN "endPrice" SET DATA TYPE DECIMAL(20, 8);
ALTER TABLE "Round" ALTER COLUMN "poolUp" SET DATA TYPE DECIMAL(20, 8);
ALTER TABLE "Round" ALTER COLUMN "poolUp" SET DEFAULT 0;
ALTER TABLE "Round" ALTER COLUMN "poolDown" SET DATA TYPE DECIMAL(20, 8);
ALTER TABLE "Round" ALTER COLUMN "poolDown" SET DEFAULT 0;

-- Round.resolvedAt
ALTER TABLE "Round" ADD COLUMN "resolvedAt" TIMESTAMP(3);

-- Prediction monetary fields
ALTER TABLE "Prediction" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(20, 8);
ALTER TABLE "Prediction" ALTER COLUMN "payout" SET DATA TYPE DECIMAL(20, 8);

-- UserStats monetary fields
ALTER TABLE "UserStats" ALTER COLUMN "totalEarnings" SET DATA TYPE DECIMAL(20, 8);
ALTER TABLE "UserStats" ALTER COLUMN "totalEarnings" SET DEFAULT 0;
ALTER TABLE "UserStats" ALTER COLUMN "upDownEarnings" SET DATA TYPE DECIMAL(20, 8);
ALTER TABLE "UserStats" ALTER COLUMN "upDownEarnings" SET DEFAULT 0;
ALTER TABLE "UserStats" ALTER COLUMN "legendsEarnings" SET DATA TYPE DECIMAL(20, 8);
ALTER TABLE "UserStats" ALTER COLUMN "legendsEarnings" SET DEFAULT 0;

-- Transaction.amount
ALTER TABLE "Transaction" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(20, 8);
