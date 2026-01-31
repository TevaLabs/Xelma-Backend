import { PrismaClient, RoundStatus } from '@prisma/client';

const prisma = new PrismaClient();

// Setup runs before all tests
beforeAll(async () => {
  console.log('🔧 Test suite setup started...');
  
  // Ensure database is connected
  try {
    await prisma.$connect();
    console.log('✅ Database connected');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    throw error;
  }
});

// Cleanup runs after all tests
afterAll(async () => {
  console.log('🧹 Test suite cleanup started...');
  
  // Clean up test data
  try {
    // Delete in correct order to avoid foreign key constraints
    await prisma.prediction.deleteMany({});
    await prisma.transaction.deleteMany({});
    await prisma.notification.deleteMany({});
    await prisma.message.deleteMany({});
    await prisma.authChallenge.deleteMany({});
    await prisma.round.deleteMany({});
    await prisma.userStats.deleteMany({});
    await prisma.user.deleteMany({});
    
    console.log('✅ Test data cleaned up');
  } catch (error) {
    console.error('⚠️  Cleanup warning:', error);
  }
  
  // Disconnect from database
  await prisma.$disconnect();
  console.log('✅ Database disconnected');
});

// Reset database state between tests
beforeEach(async () => {
  // Clear all data before each test for isolation
  await prisma.prediction.deleteMany({});
  await prisma.transaction.deleteMany({});
  await prisma.notification.deleteMany({});
  await prisma.round.deleteMany({
    where: {
      // Only delete test rounds
      startPrice: { gte: 0 },
    },
  });
});

// Global test utilities
export const testUtils = {
  /**
   * Create a test user with wallet
   */
  async createTestUser(walletAddress: string, role: 'USER' | 'ADMIN' | 'ORACLE' = 'USER') {
    return await prisma.user.create({
      data: {
        walletAddress,
        publicKey: walletAddress,
        role,
        virtualBalance: 1000,
      },
    });
  },

  /**
   * Create a test round
   * FIXED: Now uses proper RoundStatus enum
   */
  async createTestRound(mode: 'UP_DOWN' | 'LEGENDS' = 'UP_DOWN', status: RoundStatus = RoundStatus.ACTIVE) {
    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + 5 * 60 * 1000); // 5 minutes

    return await prisma.round.create({
      data: {
        mode: mode === 'UP_DOWN' ? 'UP_DOWN' : 'LEGENDS',
        status, // Now correctly typed as RoundStatus
        startPrice: 0.1234,
        startTime,
        endTime,
      },
    });
  },

  /**
   * Mask wallet address for logging
   */
  maskWallet(address: string): string {
    if (address.length <= 12) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  },
};