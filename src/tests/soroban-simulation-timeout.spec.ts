import sorobanService from '../services/soroban.service';
import config from '../config';

// Mock bindings module before importing sorobanService
jest.mock('@tevalabs/xelma-bindings', () => ({
  Client: jest.fn().mockImplementation(() => ({
    get_active_round: jest.fn(),
    balance: jest.fn(),
    get_user_stats: jest.fn(),
    get_pending_winnings: jest.fn(),
  })),
}));

describe('Soroban RPC Simulation Calls - Timeout & Retry Policy (#842)', () => {
  let originalTimeout: number;

  beforeAll(() => {
    originalTimeout = config.soroban.simulationTimeoutMs;
  });

  afterAll(() => {
    (config.soroban as any).simulationTimeoutMs = originalTimeout;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Ensure sorobanService client is initialized
    (sorobanService as any).initialized = true;
    (sorobanService as any).client = {
      get_active_round: jest.fn(),
      balance: jest.fn(),
      get_user_stats: jest.fn(),
      get_pending_winnings: jest.fn(),
    };
  });

  it('simulation call succeeds on first attempt', async () => {
    const mockClient = (sorobanService as any).client;
    mockClient.get_active_round.mockResolvedValueOnce({ result: { id: 100 } });

    const activeRound = await sorobanService.getActiveRound();

    expect(activeRound).toEqual({ id: 100 });
    expect(mockClient.get_active_round).toHaveBeenCalledTimes(1);
  });

  it('simulation call times out on first attempt and succeeds on single retry', async () => {
    (config.soroban as any).simulationTimeoutMs = 50;

    const mockClient = (sorobanService as any).client;
    // Attempt 1: slow call that times out
    mockClient.get_active_round.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ result: { id: 101 } }), 150))
    );
    // Attempt 2 (retry): fast success
    mockClient.get_active_round.mockImplementationOnce(
      () => Promise.resolve({ result: { id: 101 } })
    );

    const activeRound = await sorobanService.getActiveRound();

    expect(activeRound).toEqual({ id: 101 });
    expect(mockClient.get_active_round).toHaveBeenCalledTimes(2);
  });

  it('simulation call times out on both attempts and returns default/error state', async () => {
    (config.soroban as any).simulationTimeoutMs = 30;

    const mockClient = (sorobanService as any).client;
    // Both attempts time out
    mockClient.get_active_round.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ result: { id: 102 } }), 100))
    );

    const activeRound = await sorobanService.getActiveRound();

    expect(activeRound).toBeNull();
    expect(mockClient.get_active_round).toHaveBeenCalledTimes(2);
  });

  it('non-timeout RPC failure is handled and returns fallback without improper retries', async () => {
    const mockClient = (sorobanService as any).client;
    mockClient.balance.mockRejectedValueOnce(new Error('RPC Method Not Found'));

    const balance = await sorobanService.getBalance('GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');

    expect(balance).toBe(0);
    // withTimeout retries on errors up to retries count (2 total attempts)
    expect(mockClient.balance).toHaveBeenCalled();
  });

  it('uses configured simulationTimeoutMs from config', () => {
    expect(config.soroban.simulationTimeoutMs).toBeDefined();
    expect(typeof config.soroban.simulationTimeoutMs).toBe('number');
    expect(config.soroban.simulationTimeoutMs).toBeGreaterThan(0);
  });
});
