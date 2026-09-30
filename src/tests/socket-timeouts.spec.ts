import { describe, it, expect } from '@jest/globals';
import config from '../config';
import { PING_INTERVAL, PING_TIMEOUT, CONNECT_TIMEOUT } from '../socket';

describe('Configurable Socket.IO Timeouts (Issue #701)', () => {
  it('exposes positive integer defaults for socket timeouts', () => {
    expect(config.socket).toBeDefined();
    expect(config.socket.pingInterval).toBe(25000);
    expect(config.socket.pingTimeout).toBe(20000);
    expect(config.socket.connectTimeout).toBe(45000);

    expect(PING_INTERVAL).toBe(config.socket.pingInterval);
    expect(PING_TIMEOUT).toBe(config.socket.pingTimeout);
    expect(CONNECT_TIMEOUT).toBe(config.socket.connectTimeout);
  });
});
