/**
 * Issue #669 — socket room name helpers.
 *
 * Room names are the contract between the join side (socket.ts, the
 * membership protocol) and the emit side (websocket.service.ts). These tests
 * pin the format and the validation that keeps client-supplied ids from
 * addressing rooms in another namespace.
 */
import { describe, it, expect } from '@jest/globals';
import {
  CHAT_ROOM,
  InvalidRoomIdError,
  ROUND_LOBBY_ROOM,
  isMembershipRoom,
  isValidRoomId,
  roundRoom,
  userRoom,
} from '../utils/socket-rooms';

const UUID = '3f2b8c4e-9a1d-4e6f-8b2a-1c3d5e7f9a0b';
const CUID = 'clx0y1z2a0000abcd1234efgh';

describe('socket room helpers (Issue #669)', () => {
  describe('formats', () => {
    it('builds user rooms as user:<id>', () => {
      expect(userRoom(UUID)).toBe(`user:${UUID}`);
    });

    it('builds round rooms as round:<id>, or the lobby without an id', () => {
      expect(roundRoom(CUID)).toBe(`round:${CUID}`);
      expect(roundRoom('btc-updown-live')).toBe('round:btc-updown-live');
      expect(roundRoom()).toBe(ROUND_LOBBY_ROOM);
      expect(roundRoom(null)).toBe('round');
    });
  });

  describe('id validation', () => {
    it.each([UUID, CUID, 'user_1', 'a', 'x'.repeat(64)])('accepts %s', id => {
      expect(isValidRoomId(id)).toBe(true);
    });

    it.each([
      ['empty', ''],
      ['a colon (namespace injection)', 'abc:def'],
      ['a nested prefix', 'user:abc'],
      ['whitespace', 'bad id'],
      ['a wildcard', 'round*'],
      ['a path separator', 'a/b'],
      ['65 characters', 'x'.repeat(65)],
    ])('rejects an id with %s', (_label, id) => {
      expect(isValidRoomId(id)).toBe(false);
      expect(() => userRoom(id)).toThrow(InvalidRoomIdError);
      expect(() => roundRoom(id)).toThrow(InvalidRoomIdError);
    });

    it('rejects non-string ids', () => {
      expect(isValidRoomId(42)).toBe(false);
      expect(isValidRoomId(undefined)).toBe(false);
    });

    it('cannot build a room in another namespace from an id', () => {
      // A round id can never produce a user room or vice versa.
      expect(() => roundRoom('user:victim')).toThrow(InvalidRoomIdError);
      expect(() => userRoom('round:1')).toThrow(InvalidRoomIdError);
    });
  });

  describe('classification', () => {
    it('treats round, round:<id> and chat as membership rooms', () => {
      expect(CHAT_ROOM).toBe('chat');
      expect(isMembershipRoom('round')).toBe(true);
      expect(isMembershipRoom(roundRoom(UUID))).toBe(true);
      expect(isMembershipRoom('chat')).toBe(true);
    });

    it.each([
      `user:${UUID}`,
      'round:',
      'round:bad id',
      'round:user:abc',
      'chat:1',
      'lobby',
      '',
    ])('does not treat %s as a membership room', room => {
      expect(isMembershipRoom(room)).toBe(false);
    });

    it('does not treat non-strings as membership rooms', () => {
      expect(isMembershipRoom(7)).toBe(false);
      expect(isMembershipRoom(null)).toBe(false);
    });
  });
});
