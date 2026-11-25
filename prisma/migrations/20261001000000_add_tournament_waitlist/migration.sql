-- Tournament waitlist (Issue #874).
--
-- Joining a full tournament used to fail with a hard 409 ("Tournament is
-- full"), which meant the queue was implicit and lost: a user who wanted a
-- slot had to retry in a loop and there was no way to know who was next in
-- line. The waitlist makes that queue explicit and deterministic.
--
-- `position` is a monotonically increasing ticket handed out under the
-- tournament row lock (first come, first served). It is never reused, so the
-- (tournamentId, position) unique index is a stable ordering key; the rank a
-- waiting user sees is derived from it at read time.

-- CreateEnum
CREATE TYPE "TournamentWaitlistStatus" AS ENUM ('WAITING', 'PROMOTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "TournamentWaitlist" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "TournamentWaitlistStatus" NOT NULL DEFAULT 'WAITING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TournamentWaitlist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TournamentWaitlist_tournamentId_status_idx" ON "TournamentWaitlist"("tournamentId", "status");

-- CreateIndex
CREATE INDEX "TournamentWaitlist_userId_idx" ON "TournamentWaitlist"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentWaitlist_tournamentId_userId_key" ON "TournamentWaitlist"("tournamentId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentWaitlist_tournamentId_position_key" ON "TournamentWaitlist"("tournamentId", "position");

-- AddForeignKey
ALTER TABLE "TournamentWaitlist" ADD CONSTRAINT "TournamentWaitlist_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentWaitlist" ADD CONSTRAINT "TournamentWaitlist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
