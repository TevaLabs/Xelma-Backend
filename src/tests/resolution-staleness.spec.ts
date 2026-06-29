import { describe, it, expect, jest, beforeEach } from '@jest/globals';

/**
 * Settlement staleness guard (#229).
 *
 * resolutionService.resolveRound must refuse to settle while this process's
 * price feed is stale — protecting both the automated resolve loop and the
 * manual oracle/admin resolve route. The guard only applies when the oracle
 * is actively polling in this process.
 */

const mockOracle = {
  isRunning: jest.fn<() => boolean>(),
  isStale: jest.fn<() => boolean>(),
  getLastUpdatedAt: jest.fn<() => Date | null>(() => null),
  getStalenessSeconds: jest.fn<() => number | null>(() => null),
  getStalenessThresholdMs: jest.fn<() => number>(() => 60_000),
};
jest.mock('../services/oracle', () => ({ __esModule: true, default: mockOracle }));

const mockPrisma = {
  round: { findUnique: jest.fn<(...args: any[]) => Promise<any>>() },
};
jest.mock('../lib/prisma', () => ({ __esModule: true, prisma: mockPrisma }));

// soroban.service transitively imports @stellar/stellar-sdk (ESM under pnpm),
// which jest cannot parse. The guard never reaches it, so stub it out.
jest.mock('../services/soroban.service', () => ({
  __esModule: true,
  default: { resolveRound: jest.fn() },
}));

import resolutionService from '../services/resolution.service';
import { ErrorCode } from '../utils/errors';
import { RoundLifecycleOutcome } from '../types/round.types';

describe('ResolutionService — oracle staleness guard (#229)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: round does not exist → resolveRound returns NO_OP once past the guard.
    mockPrisma.round.findUnique.mockResolvedValue(null);
  });

  it('refuses to resolve with 503 EXTERNAL_SERVICE_ERROR when oracle is running and stale', async () => {
    mockOracle.isRunning.mockReturnValue(true);
    mockOracle.isStale.mockReturnValue(true);

    await expect(
      resolutionService.resolveRound('round-1', '0.10000000'),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: ErrorCode.EXTERNAL_SERVICE_ERROR,
    });

    // Guard must short-circuit before any DB work.
    expect(mockPrisma.round.findUnique).not.toHaveBeenCalled();
  });

  it('proceeds past the guard when oracle is running and fresh', async () => {
    mockOracle.isRunning.mockReturnValue(true);
    mockOracle.isStale.mockReturnValue(false);

    const result = await resolutionService.resolveRound('round-1', '0.10000000');

    expect(mockPrisma.round.findUnique).toHaveBeenCalled();
    expect(result).toEqual({ outcome: RoundLifecycleOutcome.NO_OP });
  });

  it('does not assess staleness when the oracle is not running (API-only / test process)', async () => {
    mockOracle.isRunning.mockReturnValue(false);
    // Even though it would report stale, a non-polling process must not block.
    mockOracle.isStale.mockReturnValue(true);

    const result = await resolutionService.resolveRound('round-1', '0.10000000');

    expect(mockOracle.isStale).not.toHaveBeenCalled();
    expect(mockPrisma.round.findUnique).toHaveBeenCalled();
    expect(result).toEqual({ outcome: RoundLifecycleOutcome.NO_OP });
  });
});
