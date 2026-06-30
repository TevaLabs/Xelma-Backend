import { prisma } from "../lib/prisma";
import { NotFoundError, ConflictError, ValidationError } from "../utils/errors";

export class TournamentService {
  async joinTournament(userId: string, tournamentId: string): Promise<{ currentParticipants: number }> {
    const tournament = await prisma.tournament.findUnique({
      where: { id: tournamentId },
    });

    if (!tournament) {
      throw new NotFoundError("Tournament not found");
    }

    if (tournament.status === "CANCELLED") {
      throw new ValidationError("Tournament is cancelled");
    }

    if (tournament.currentParticipants >= tournament.maxParticipants) {
      throw new ConflictError("Tournament is full");
    }

    const existing = await prisma.tournamentParticipant.findUnique({
      where: {
        tournamentId_userId: { tournamentId, userId },
      },
    });

    if (existing) {
      throw new ConflictError("Already joined this tournament");
    }

    const [, updated] = await prisma.$transaction([
      prisma.tournamentParticipant.create({
        data: { tournamentId, userId },
      }),
      prisma.tournament.update({
        where: { id: tournamentId },
        data: { currentParticipants: { increment: 1 } },
      }),
    ]);

    return { currentParticipants: updated.currentParticipants };
  }
}

export default new TournamentService();
