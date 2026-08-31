-- Tournament saga lifecycle tables (Issue #502).
--
-- The Tournament / TournamentParticipant models were declared in
-- prisma/schema.prisma but no migration ever created these tables, so any
-- database-mode tournament operation (join, lock, settle, payout) failed with
-- "table does not exist". This migration brings the database in line with the
-- declared schema so the tournament saga can execute natively in database mode.

-- CreateEnum
CREATE TYPE "TournamentStatus" AS ENUM ('UPCOMING', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Tournament" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "mode" "GameMode" NOT NULL,
    "status" "TournamentStatus" NOT NULL DEFAULT 'UPCOMING',
    "entryFee" DECIMAL(20,8) NOT NULL,
    "prizePool" DECIMAL(20,8) NOT NULL,
    "maxParticipants" INTEGER NOT NULL,
    "currentParticipants" INTEGER NOT NULL DEFAULT 0,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "rounds" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tournament_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentParticipant" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TournamentParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Tournament_status_idx" ON "Tournament"("status");

-- CreateIndex
CREATE INDEX "Tournament_mode_idx" ON "Tournament"("mode");

-- CreateIndex
CREATE INDEX "TournamentParticipant_tournamentId_idx" ON "TournamentParticipant"("tournamentId");

-- CreateIndex
CREATE INDEX "TournamentParticipant_userId_idx" ON "TournamentParticipant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentParticipant_tournamentId_userId_key" ON "TournamentParticipant"("tournamentId", "userId");

-- AddForeignKey
ALTER TABLE "TournamentParticipant" ADD CONSTRAINT "TournamentParticipant_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentParticipant" ADD CONSTRAINT "TournamentParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;