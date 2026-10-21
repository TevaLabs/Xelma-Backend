import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockUserUpsert = jest.fn();

jest.mock('@prisma/client', () => ({
  UserRole: { USER: 'USER', ADMIN: 'ADMIN', ORACLE: 'ORACLE' },
  PrismaClient: class {
    user = { upsert: (...args: any[]) => mockUserUpsert(...args) };
    $disconnect = jest.fn();
  },
}));

import { ORACLE_ALLOWED_ROLES } from '../security/route-auth.registry';
import { DEMO_ROLE_USERS, main, seedDemoRoleUsers } from '../../prisma/seed';

describe('Prisma demo role seed', () => {
  const users = new Map<string, any>();

  beforeEach(() => {
    jest.clearAllMocks();
    users.clear();
    users.set('unrelated-wallet', {
      walletAddress: 'unrelated-wallet',
      role: 'USER',
      nickname: 'Keep me',
    });
    mockUserUpsert.mockImplementation(async ({ where, create, update }: any) => {
      const current = users.get(where.walletAddress);
      if (current) {
        Object.assign(current, update);
        return current;
      }
      users.set(where.walletAddress, { ...create });
      return users.get(where.walletAddress);
    });
  });

  it('seeds the actual ADMIN and ORACLE enum roles with stable wallet identifiers', async () => {
    await seedDemoRoleUsers();

    expect([...users.values()]).toEqual([
      expect.objectContaining({ walletAddress: 'unrelated-wallet', role: 'USER', nickname: 'Keep me' }),
      ...DEMO_ROLE_USERS.map((demoUser) => expect.objectContaining({
        walletAddress: demoUser.walletAddress,
        publicKey: demoUser.walletAddress,
        role: demoUser.role,
      })),
    ]);
    expect(ORACLE_ALLOWED_ROLES).toContain('ORACLE');
    expect(ORACLE_ALLOWED_ROLES).toContain('ADMIN');
  });

  it('is idempotent and preserves unrelated users on repeated runs', async () => {
    await seedDemoRoleUsers();
    await seedDemoRoleUsers();

    expect(users.size).toBe(3);
    expect(users.get('unrelated-wallet')).toEqual({
      walletAddress: 'unrelated-wallet',
      role: 'USER',
      nickname: 'Keep me',
    });
    expect(mockUserUpsert).toHaveBeenCalledTimes(4);
    for (const [args] of mockUserUpsert.mock.calls) {
      expect(args.update).toEqual({ role: args.create.role });
    }
  });

  it('assigns the reserved role without overwriting other fields on that identity', async () => {
    const admin = DEMO_ROLE_USERS[0];
    users.set(admin.walletAddress, {
      walletAddress: admin.walletAddress,
      role: 'USER',
      nickname: 'Existing local profile',
      publicKey: 'existing-public-key',
    });

    await seedDemoRoleUsers();

    expect(users.get(admin.walletAddress)).toEqual({
      walletAddress: admin.walletAddress,
      role: 'ADMIN',
      nickname: 'Existing local profile',
      publicKey: 'existing-public-key',
    });
  });

  it('refuses to run the seed in production', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousSafetyProfile = process.env.SAFETY_PROFILE;
    process.env.NODE_ENV = 'production';

    try {
      await expect(main()).rejects.toThrow('development-only');
      expect(mockUserUpsert).not.toHaveBeenCalled();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousSafetyProfile === undefined) delete process.env.SAFETY_PROFILE;
      else process.env.SAFETY_PROFILE = previousSafetyProfile;
    }
  });

  it('also refuses to run under the production safety profile', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousSafetyProfile = process.env.SAFETY_PROFILE;
    process.env.NODE_ENV = 'development';
    process.env.SAFETY_PROFILE = 'production';

    try {
      await expect(main()).rejects.toThrow('development-only');
      expect(mockUserUpsert).not.toHaveBeenCalled();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousSafetyProfile === undefined) delete process.env.SAFETY_PROFILE;
      else process.env.SAFETY_PROFILE = previousSafetyProfile;
    }
  });
});