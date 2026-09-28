/**
 * Issue #730 — socket room-name sanitization & bounding.
 *
 * The room-join gate is `isSafeRoomName` (used by `socket.ts` for the resume
 * re-join and `join:notifications`, plus `isValidIdSegment` / `isValidSessionId`
 * for `join:round` and `join:session`). These tests pin the behaviour that
 * makes crafted room names impossible:
 *
 *   - invalid ids are rejected (wildcards, separators, oversized strings);
 *   - session rooms are always namespaced under `session:` and cannot alias
 *     a `user:` room;
 *   - room names are bounded in length.
 */
import { describe, it, expect } from '@jest/globals';
import {
  MAX_ROOM_ID_LENGTH,
  MAX_ROOM_NAME_LENGTH,
  SESSION_ROOM_PREFIX,
  isSafeRoomName,
  isValidIdSegment,
  isValidSessionId,
  sessionRoom,
} from '../utils/socket-room.util';

const UUID = '6f1c2c74-9f0a-4b5e-8f0b-2f3f1f8a91cd';
const CUID = 'clh3q4x9b0000abcdefghijklm';

describe('isValidSessionId (Issue #730)', () => {
  it('accepts uuid and cuid session ids', () => {
    expect(isValidSessionId(UUID)).toBe(true);
    expect(isValidSessionId(UUID.toUpperCase())).toBe(true);
    expect(isValidSessionId(CUID)).toBe(true);
  });

  it('rejects wildcards, separators and namespaced ids', () => {
    expect(isValidSessionId('*')).toBe(false);
    expect(isValidSessionId('user:someone-else')).toBe(false);
    expect(isValidSessionId('session:abc')).toBe(false);
    expect(isValidSessionId('../../etc/passwd')).toBe(false);
    expect(isValidSessionId('not-a-uuid')).toBe(false);
    expect(isValidSessionId('')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isValidSessionId(undefined)).toBe(false);
    expect(isValidSessionId(null)).toBe(false);
    expect(isValidSessionId(42)).toBe(false);
    expect(isValidSessionId({ id: UUID })).toBe(false);
  });

  it('rejects oversized ids', () => {
    const huge = `c${'a'.repeat(MAX_ROOM_ID_LENGTH * 4)}`;
    expect(isValidSessionId(huge)).toBe(false);
  });
});

describe('isValidIdSegment (Issue #730)', () => {
  it('accepts bounded slugs used as round/user ids', () => {
    expect(isValidIdSegment('round-123')).toBe(true);
    expect(isValidIdSegment('btc-updown-live')).toBe(true);
    expect(isValidIdSegment(UUID)).toBe(true);
  });

  it('rejects wildcards, whitespace and unbounded strings', () => {
    expect(isValidIdSegment('*')).toBe(false);
    expect(isValidIdSegment('round 123')).toBe(false);
    expect(isValidIdSegment('round123\n')).toBe(false);
    expect(isValidIdSegment('a'.repeat(MAX_ROOM_ID_LENGTH + 1))).toBe(false);
    expect(isValidIdSegment('<script>')).toBe(false);
    expect(isValidIdSegment('')).toBe(false);
  });
});

describe('sessionRoom (Issue #730)', () => {
  it('namespaces the id under session:', () => {
    expect(sessionRoom(UUID)).toBe(`${SESSION_ROOM_PREFIX}${UUID}`);
    expect(sessionRoom(UUID).startsWith('session:')).toBe(true);
  });

  it('can never alias a user: room', () => {
    expect(sessionRoom(UUID)).not.toBe(`user:${UUID}`);
    expect(sessionRoom(UUID).startsWith('user:')).toBe(false);
  });
});

describe('isSafeRoomName (Issue #730)', () => {
  it('accepts singleton and well-formed namespaced rooms', () => {
    expect(isSafeRoomName('round')).toBe(true);
    expect(isSafeRoomName('chat')).toBe(true);
    expect(isSafeRoomName(`round:${UUID}`)).toBe(true);
    expect(isSafeRoomName('round:btc-updown-live')).toBe(true);
    expect(isSafeRoomName(`user:${UUID}`)).toBe(true);
    expect(isSafeRoomName(`session:${UUID}`)).toBe(true);
    expect(isSafeRoomName(`session:${CUID}`)).toBe(true);
  });

  it('rejects unroutable or unknown prefixes', () => {
    expect(isSafeRoomName('evil')).toBe(false);
    expect(isSafeRoomName('admin:all')).toBe(false);
    expect(isSafeRoomName('room')).toBe(false);
    expect(isSafeRoomName('user')).toBe(false);
    expect(isSafeRoomName('session')).toBe(false);
    expect(isSafeRoomName('user:')).toBe(false);
    expect(isSafeRoomName('round:')).toBe(false);
    expect(isSafeRoomName('round:*')).toBe(false);
    expect(isSafeRoomName('user:*')).toBe(false);
    expect(isSafeRoomName('round:../user:1')).toBe(false);
  });

  it('requires cuid/uuid for session rooms but slugs for other namespaces', () => {
    // A slug is fine for round/user rooms…
    expect(isSafeRoomName('round:legacy-round-id')).toBe(true);
    // …but never for a session room (strict format).
    expect(isSafeRoomName('session:legacy-round-id')).toBe(false);
  });

  it('bounds room name length', () => {
    const tooLong = `round:${'a'.repeat(MAX_ROOM_NAME_LENGTH)}`;
    expect(tooLong.length).toBeGreaterThan(MAX_ROOM_NAME_LENGTH);
    expect(isSafeRoomName(tooLong)).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isSafeRoomName(undefined)).toBe(false);
    expect(isSafeRoomName(null)).toBe(false);
    expect(isSafeRoomName(42)).toBe(false);
  });
});
