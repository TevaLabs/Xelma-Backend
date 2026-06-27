import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

// These tests ensure the `DATA_MODE` env var is parsed into config.app.dataMode
// and can be toggled for local/demo usage.

describe('DATA_MODE config', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    // restore env and reset modules
    process.env = { ...savedEnv };
    jest.resetModules();
  });

  it('defaults to live when unset', async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-secret';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/testdb';

    jest.resetModules();
    const config = (await import('../config')).default;
    expect(config.app.dataMode).toBe('live');
  });

  it('parses mock mode when DATA_MODE=mock', async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-secret';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/testdb';
    process.env.DATA_MODE = 'mock';

    jest.resetModules();
    const config = (await import('../config')).default;
    expect(config.app.dataMode).toBe('mock');
  });
});
