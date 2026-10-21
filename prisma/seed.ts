
import { GameMode, PrismaClient, TournamentStatus, UserRole } from '@prisma/client';

const prisma = new PrismaClient();

// Public, valid Stellar fixture keys reserved for local RBAC development.
// Their private signing keys are intentionally not stored in this repository.
export const DEMO_ROLE_USERS = [
    {
        walletAddress: 'GB2IKI5ONW2CQBD7WX4I76B5V65KQNEEVBLFYSYPC4IMHENDNBR5AYUN',
        role: UserRole.ADMIN,
    },
    {
        walletAddress: 'GDRHOLGIIVOGHNURCNVVGUXBUJCVTSKH2V7ACB4E4ZOR7KC3XGIBK5CT',
        role: UserRole.ORACLE,
    },
] as const;

export async function seedDemoRoleUsers(
  client: Pick<PrismaClient, 'user'> = prisma
) {
    for (const demoUser of DEMO_ROLE_USERS) {
        await client.user.upsert({
            where: { walletAddress: demoUser.walletAddress },
            update: { role: demoUser.role },
            create: {
                walletAddress: demoUser.walletAddress,
                publicKey: demoUser.walletAddress,
                role: demoUser.role,
            },
        });
    }
}

export async function main() {
    if (
        process.env.NODE_ENV === 'production' ||
        process.env.SAFETY_PROFILE === 'production'
    ) {
        throw new Error('Prisma seed is development-only and cannot run in production');
    }

    console.log('🌱 Starting seed...');

    await seedDemoRoleUsers();
    console.log('✅ Seeded local demo ADMIN and ORACLE identities.');

    // Create or update a test user
    const user = await prisma.user.upsert({
        where: { walletAddress: 'G_TEST_WALLET_ADDRESS_123456789' },
        update: {},
        create: {
            walletAddress: 'G_TEST_WALLET_ADDRESS_123456789',
            publicKey: 'G_TEST_PUBLIC_KEY',
            wins: 5,
            streak: 2,
            virtualBalance: 2500.50,
            messages: {
                create: [
                    { content: 'Hello World! This is a test message.' },
                    { content: 'Xelma backend is looking great! 🚀' },
                ],
            },
        },
    });

    console.log(`✅ User seeded: ${user.walletAddress}`);
    console.log(`stats: wins=${user.wins}, streak=${user.streak}, balance=${user.virtualBalance}`);

    const messages = await prisma.message.findMany({ where: { userId: user.id } });
    console.log(`✅ Seeded ${messages.length} messages for user.`);

    // Seed demo tournaments across the saga lifecycle (Issue #502).
    // These give the tournaments API a full spread of states for local
    // development and testing of the create->join->lock->settle workflow.
    const tournamentSeeds = [
      {
        name: 'XLM Prediction Championship',
        description: 'Compete against the best predictors in a multi-round UP/DOWN tournament.',
        mode: GameMode.UP_DOWN,
        status: TournamentStatus.ACTIVE,
        entryFee: 50,
        prizePool: 5000,
        maxParticipants: 100,
        currentParticipants: 67,
        startTime: new Date('2026-06-25T10:00:00Z'),
        endTime: new Date('2026-06-28T10:00:00Z'),
        rounds: 10,
      },
      {
        name: 'Legends Weekly Showdown',
        description: 'Range-based prediction tournament for experienced players. Weekly prizes.',
        mode: GameMode.LEGENDS,
        status: TournamentStatus.UPCOMING,
        entryFee: 100,
        prizePool: 10000,
        maxParticipants: 50,
        currentParticipants: 12,
        startTime: new Date('2026-07-01T00:00:00Z'),
        endTime: new Date('2026-07-07T23:59:59Z'),
        rounds: 20,
      },
      {
        name: 'Beginner Friendly Cup',
        description: 'Low entry fee tournament perfect for newcomers. Learn and earn!',
        mode: GameMode.UP_DOWN,
        status: TournamentStatus.COMPLETED,
        entryFee: 10,
        prizePool: 500,
        maxParticipants: 200,
        currentParticipants: 143,
        startTime: new Date('2026-06-18T00:00:00Z'),
        endTime: new Date('2026-06-20T23:59:59Z'),
        rounds: 5,
      },
    ];

    for (const t of tournamentSeeds) {
      await prisma.tournament.upsert({
        where: { id: `${t.name.toLowerCase().replace(/\s+/g, '-')}` },
        update: t,
        create: { ...t, id: `${t.name.toLowerCase().replace(/\s+/g, '-')}` },
      });
    }
    console.log(`✅ Seeded ${tournamentSeeds.length} demo tournaments.`);
}

if (require.main === module) {
    main()
        .catch((e) => {
            console.error(e);
            process.exitCode = 1;
        })
        .finally(async () => {
            await prisma.$disconnect();
        });
}
