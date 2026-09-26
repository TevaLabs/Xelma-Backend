/**
 * Round lifecycle state machine unit tests (Issue #490).
 *
 * These tests exercise the centralized transition engine
 * (`round-lifecycle.service` / `transitionRound`) and the DAG it validates
 * against (`types/round.types`). They are DB-free: prisma is replaced by a
 * deterministic in-memory proxy so the focus is on the *rules*, not the
 * storage backend. Concurrency safety is additionally covered by the DB-backed
 * tests in `resolution-concurrency.spec.ts`.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  RoundStatus,
  isLegalRoundTransition,
  allowedSourcesFor,
  ROUND_LIFECYCLE_TRANSITIONS,
} from '../types/round.types';
import { IllegalRoundTransitionError } from '../utils/errors';

// ─── metrics spy (against the real counter) ─────────────────────────────────
import { roundTransitionFailuresTotal } from '../metrics/application.metrics';
const roundTransitionFailuresInc = jest.spyOn(roundTransitionFailuresTotal, 'inc');

// ─── in-memory prisma proxy ─────────────────────────────────────────────────
const rounds = new Map<string, { id: string; status: string }>();
const mockRoundUpdateMany = jest.fn();
const mockRoundFindUnique = jest.fn();
const mockRoundUpdate = jest.fn();

jest.mock('../lib/prisma', () => ({
  prisma: {
    round: {
      findUnique: (...args: any[]) => mockRoundFindUnique(...args),
      update: (...args: any[]) => mockRoundUpdate(...args),
      updateMany: (...args: any[]) => mockRoundUpdateMany(...args),
    },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

// websocket emits are intentionally stubbed — the engine broadcasts on success.
jest.mock('../services/websocket.service', () => ({
  __esModule: true,
  default: { emitRoundUpdate: jest.fn() },
}));

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import roundLifecycleService from '../services/round-lifecycle.service';
import roundService from '../services/round.service';
import { RoundLifecycleOutcome } from '../types/round.types';

function seed(status: string, id = 'round-1') {
  rounds.set(id, { id, status });
}

function installProxy() {
  mockRoundUpdateMany.mockReset();
  mockRoundFindUnique.mockReset();
  mockRoundUpdate.mockReset();
  roundTransitionFailuresInc.mockClear();

  mockRoundFindUnique.mockImplementation(async ({ where }: any) => {
    const r = rounds.get(where.id);
    if (!r) return null;
    return { id: r.id, status: r.status };
  });
  mockRoundUpdateMany.mockImplementation(async ({ where, data }: any) => {
    const r = rounds.get(where.id);
    if (!r) return { count: 0 };
    if (where.status && !(where.status as any).in.includes(r.status)) {
      return { count: 0 };
    }
    r.status = data.status as string;
    rounds.set(where.id, { ...r });
    return { count: 1 };
  });
  mockRoundUpdate.mockImplementation(async ({ where, data }: any) => {
    const r = rounds.get(where.id);
    if (!r) throw new Error('not found');
    r.status = data.status as string;
    rounds.set(where.id, { ...r });
    return { ...r };
  });
}

beforeEach(() => {
  rounds.clear();
});

describe('Round lifecycle state machine (Issue #490)', () => {
  describe('transition graph (round.types.ts)', () => {
    it('defines the canonical open -> locked -> resolved/cancelled edges', () => {
      // Active (open) rounds may be locked or cancelled.
      expect(isLegalRoundTransition('ACTIVE', 'LOCKED')).toBe(true);
      expect(isLegalRoundTransition('ACTIVE', 'CANCELLED')).toBe(true);

      // Locked rounds may only be resolved or cancelled — never reopened.
      expect(isLegalRoundTransition('LOCKED', 'RESOLVED')).toBe(true);
      expect(isLegalRoundTransition('LOCKED', 'CANCELLED')).toBe(true);
      expect(isLegalRoundTransition('LOCKED', 'ACTIVE')).toBe(false);

      // Terminal states are absorbing.
      expect(isLegalRoundTransition('RESOLVED', 'RESOLVED')).toBe(false);
      expect(isLegalRoundTransition('CANCELLED', 'RESOLVED')).toBe(false);
      expect(isLegalRoundTransition('RESOLVED', 'CANCELLED')).toBe(false);
    });

    it('only ever allows clearly-defined destination sources', () => {
      expect(allowedSourcesFor('LOCKED')).toEqual(['ACTIVE']);
      // RESOLVED is only reachable from LOCKED — an open round must lock first.
      expect(allowedSourcesFor('RESOLVED')).toEqual(['LOCKED']);
      expect(allowedSourcesFor('CANCELLED').sort()).toEqual(['ACTIVE', 'LOCKED'].sort());
    });

    it('exposes the full graph with every persisted state at least mentioned', () => {
      const states = new Set([
        ...Object.keys(ROUND_LIFECYCLE_TRANSITIONS),
        ...Object.values(ROUND_LIFECYCLE_TRANSITIONS).flat(),
      ]);
      for (const s of ['PENDING', 'ACTIVE', 'LOCKED', 'RESOLVED', 'CANCELLED'] as RoundStatus[]) {
        expect(states.has(s)).toBe(true);
      }
    });
  });

  describe('transitionRound', () => {
    it('performs a legal LOCKED -> RESOLVED transition', async () => {
      installProxy();
      seed('LOCKED');

      const round = await roundLifecycleService.transitionRound('round-1', 'RESOLVED');
      expect(round.status).toBe('RESOLVED');
      expect(mockRoundUpdateMany).toHaveBeenCalledTimes(1);
      expect(roundTransitionFailuresInc).not.toHaveBeenCalled();
    });

    it('throws a deterministic IllegalRoundTransitionError for an illegal hop', async () => {
      installProxy();
      // ACTIVE -> RESOLVED is illegal: an open round must be locked first.
      seed('ACTIVE');

      await expect(
        roundLifecycleService.transitionRound('round-1', 'RESOLVED'),
      ).rejects.toThrow(IllegalRoundTransitionError);

      // The engine must hold the row in its original state (no partial write).
      expect(findStoredStatus('round-1')).toBe('ACTIVE');
      // And it must increment the failure metric with the from/to pair.
      expect(roundTransitionFailuresInc).toHaveBeenCalledWith({
        from: 'ACTIVE',
        to: 'RESOLVED',
      });
    });

    it('throws NotFoundError when the round does not exist', async () => {
      installProxy();
      await expect(
        roundLifecycleService.transitionRound('missing', 'RESOLVED'),
      ).rejects.toThrow('Round not found');
      expect(mockRoundUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('roundService.lockRound delegates to the state machine', () => {
    it('returns UPDATED for an ACTIVE -> LOCKED hop', async () => {
      installProxy();
      seed('ACTIVE');
      const outcome = await roundService.lockRound('round-1');
      expect(outcome).toBe(RoundLifecycleOutcome.UPDATED);
      expect(findStoredStatus('round-1')).toBe('LOCKED');
    });

    it('reports ALREADY_LOCKED for a round that is already locked', async () => {
      installProxy();
      seed('LOCKED');
      const outcome = await roundService.lockRound('round-1');
      expect(outcome).toBe(RoundLifecycleOutcome.ALREADY_LOCKED);
      expect(findStoredStatus('round-1')).toBe('LOCKED');
    });

    it('returns NO_OP for missing rounds and final rounds', async () => {
      installProxy();
      const missing = await roundService.lockRound('nope');
      expect(missing).toBe(RoundLifecycleOutcome.NO_OP);

      seed('RESOLVED');
      expect(await roundService.lockRound('round-1')).toBe(RoundLifecycleOutcome.NO_OP);

      seed('CANCELLED');
      expect(await roundService.lockRound('round-1')).toBe(RoundLifecycleOutcome.NO_OP);
    });
  });
});

function findStoredStatus(id: string): string | undefined {
  return rounds.get(id)?.status;
}