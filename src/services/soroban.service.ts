import { Keypair, Networks } from "@stellar/stellar-sdk";
import logger from "../utils/logger";

/**
 * Blockchain error classification for proper handling
 */
export enum BlockchainErrorType {
  TRANSIENT = "TRANSIENT",
  VALIDATION = "VALIDATION",
  INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS",
  CONTRACT_ERROR = "CONTRACT_ERROR",
  TIMEOUT = "TIMEOUT",
  UNKNOWN = "UNKNOWN",
}

/**
 * Structured blockchain error with retry guidance
 */
export class BlockchainError extends Error {
  constructor(
    public readonly type: BlockchainErrorType,
    public readonly message: string,
    public readonly retryable: boolean,
    public readonly originalError?: any,
    public readonly txHash?: string,
  ) {
    super(message);
    this.name = "BlockchainError";
    Object.setPrototypeOf(this, BlockchainError.prototype);
  }

  toJSON() {
    return {
      type: this.type,
      message: this.message,
      retryable: this.retryable,
      txHash: this.txHash,
      name: this.name,
    };
  }
}

/**
 * Configuration for retry behavior
 */
interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
}

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  timeoutMs: 30000,
};

/**
 * BetSide type definition
 */
type BetSide =
  | { tag: "Up"; values: undefined }
  | { tag: "Down"; values: undefined };

/**
 * Mock Soroban Client for when real bindings aren't available
 */
class MockSorobanClient {
  constructor(config: any) {
    logger.warn('🔧 Using MOCK Soroban client (bindings not available)', {
      contractId: config.contractId?.slice(0, 8) + '...',
      network: config.networkPassphrase,
    });
  }

  async create_round(params: any): Promise<string> {
    logger.info('📝 MOCK: create_round', {
      start_price: params.start_price.toString(),
      duration_ledgers: params.duration_ledgers,
    });
    return 'mock_create_round_tx_' + Date.now();
  }

  async place_bet(params: any): Promise<string> {
    logger.info('📝 MOCK: place_bet', {
      user: params.user.slice(0, 8) + '...',
      amount: params.amount.toString(),
      side: params.side.tag,
    });
    if (params.amount <= 0n) {
      throw new Error('Amount must be positive');
    }
    return 'mock_place_bet_tx_' + Date.now();
  }

  async resolve_round(params: any): Promise<string> {
    logger.info('📝 MOCK: resolve_round', {
      final_price: params.final_price.toString(),
    });
    return 'mock_resolve_round_tx_' + Date.now();
  }

  async get_active_round(): Promise<any> {
    logger.info('📝 MOCK: get_active_round');
    return null;
  }

  async mint_initial(params: any): Promise<bigint> {
    logger.info('📝 MOCK: mint_initial', {
      user: params.user.slice(0, 8) + '...',
    });
    return BigInt(1000 * 10_000_000);
  }

  async balance(params: any): Promise<bigint> {
    logger.info('📝 MOCK: balance', {
      user: params.user.slice(0, 8) + '...',
    });
    return BigInt(1000 * 10_000_000);
  }
}

/**
 * Load Soroban Client (real or mock)
 */
function loadSorobanClient(): any {
  try {
    // Try to load real bindings
    const bindings = require('@tevalabs/xelma-bindings');
    logger.info('✅ Loaded real Soroban bindings');
    return bindings.Client;
  } catch (error) {
    logger.warn('⚠️  Real Soroban bindings not available, using mock');
    return MockSorobanClient;
  }
}

const Client = loadSorobanClient();

/**
 * Production-grade Soroban service with comprehensive error handling
 * PRESERVES all original functionality
 */
export class SorobanService {
  private client: any = null;
  private adminKeypair: Keypair | null = null;
  private oracleKeypair: Keypair | null = null;
  private initialized = false;
  private readonly contractId: string | null = null;
  private rpcUrl: string | null = null;
  private networkPassphrase: string | null = null;

  constructor() {
    try {
      const contractId = process.env.SOROBAN_CONTRACT_ID;
      const network = process.env.SOROBAN_NETWORK || "testnet";
      const rpcUrl =
        process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
      const adminSecret = process.env.SOROBAN_ADMIN_SECRET;
      const oracleSecret = process.env.SOROBAN_ORACLE_SECRET;

      // Hard-disable if anything critical is missing (ORIGINAL BEHAVIOR)
      if (!contractId || !adminSecret || !oracleSecret) {
        logger.warn(
          "Soroban configuration incomplete. Blockchain integration DISABLED.",
          {
            hasContractId: !!contractId,
            hasAdminSecret: !!adminSecret,
            hasOracleSecret: !!oracleSecret,
          }
        );
        return;
      }

      this.networkPassphrase =
        network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
      this.rpcUrl = rpcUrl;
      (this.contractId as any) = contractId;

      // Initialize client (works with both real and mock)
      this.client = new Client({
        contractId,
        networkPassphrase: this.networkPassphrase,
        rpcUrl,
      });

      this.adminKeypair = Keypair.fromSecret(adminSecret);
      this.oracleKeypair = Keypair.fromSecret(oracleSecret);
      this.initialized = true;

      logger.info("Soroban service initialized successfully", {
        network,
        contractId: contractId.slice(0, 8) + '...',
        rpcUrl,
      });
    } catch (error: any) {
      logger.error("Failed to initialize Soroban service", {
        error: error.message,
        stack: error.stack,
      });
      this.initialized = false;
    }
  }

  /**
   * Check if service is ready for operations
   */
  private ensureInitialized(): void {
    if (!this.initialized || !this.client) {
      throw new BlockchainError(
        BlockchainErrorType.VALIDATION,
        "Soroban service is not initialized. Check environment configuration.",
        false,
      );
    }
  }

  /**
   * Classify error for appropriate handling (NEW)
   */
  private classifyError(error: any, operation: string): BlockchainError {
    const errorMessage = error?.message || String(error);
    const errorString = errorMessage.toLowerCase();

    if (
      errorString.includes("timeout") ||
      errorString.includes("econnrefused") ||
      errorString.includes("enotfound") ||
      errorString.includes("network")
    ) {
      return new BlockchainError(
        BlockchainErrorType.TRANSIENT,
        `Network error during ${operation}: ${errorMessage}`,
        true,
        error,
      );
    }

    if (
      errorString.includes("insufficient") ||
      errorString.includes("balance") ||
      errorString.includes("funds")
    ) {
      return new BlockchainError(
        BlockchainErrorType.INSUFFICIENT_FUNDS,
        `Insufficient funds for ${operation}`,
        false,
        error,
      );
    }

    if (
      errorString.includes("alreadybet") ||
      errorString.includes("already") ||
      errorString.includes("contract")
    ) {
      return new BlockchainError(
        BlockchainErrorType.CONTRACT_ERROR,
        `Contract error during ${operation}: ${errorMessage}`,
        false,
        error,
      );
    }

    if (
      errorString.includes("invalid") ||
      errorString.includes("validation") ||
      errorString.includes("parameter")
    ) {
      return new BlockchainError(
        BlockchainErrorType.VALIDATION,
        `Validation error during ${operation}: ${errorMessage}`,
        false,
        error,
      );
    }

    return new BlockchainError(
      BlockchainErrorType.UNKNOWN,
      `Unknown error during ${operation}: ${errorMessage}`,
      false,
      error,
    );
  }

  /**
   * Execute operation with retry logic and exponential backoff (NEW)
   */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    operationName: string,
    config: RetryConfig = DEFAULT_RETRY_CONFIG,
  ): Promise<T> {
    let lastError: BlockchainError | null = null;
    const startTime = Date.now();

    for (let attempt = 0; attempt < config.maxRetries; attempt++) {
      if (Date.now() - startTime > config.timeoutMs) {
        throw new BlockchainError(
          BlockchainErrorType.TIMEOUT,
          `Operation ${operationName} exceeded timeout of ${config.timeoutMs}ms`,
          false,
          lastError,
        );
      }

      try {
        logger.debug(
          `Executing ${operationName}, attempt ${attempt + 1}/${config.maxRetries}`,
        );
        const result = await operation();
        if (attempt > 0) {
          logger.info(
            `${operationName} succeeded after ${attempt + 1} attempts`,
          );
        }
        return result;
      } catch (error: any) {
        lastError = this.classifyError(error, operationName);

        logger.warn(`${operationName} attempt ${attempt + 1} failed`, {
          errorType: lastError.type,
          retryable: lastError.retryable,
          message: lastError.message,
        });

        if (!lastError.retryable || attempt === config.maxRetries - 1) {
          throw lastError;
        }

        const baseDelay = config.baseDelayMs * Math.pow(2, attempt);
        const jitter = Math.random() * 0.3 * baseDelay;
        const delay = Math.min(baseDelay + jitter, config.maxDelayMs);

        await this.sleep(delay);
      }
    }

    throw (
      lastError ||
      new BlockchainError(
        BlockchainErrorType.UNKNOWN,
        `Unexpected error in retry logic for ${operationName}`,
        false,
      )
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private priceToStroops(price: number): bigint {
    if (!Number.isFinite(price) || price <= 0) {
      throw new BlockchainError(
        BlockchainErrorType.VALIDATION,
        `Invalid price: ${price}. Must be a positive number.`,
        false,
      );
    }
    return BigInt(Math.floor(price * 10_000_000));
  }

  private stroopsToXLM(stroops: bigint): number {
    return Number(stroops) / 10_000_000;
  }

  private createBetSide(side: "UP" | "DOWN"): BetSide {
    return side === "UP"
      ? { tag: "Up", values: undefined }
      : { tag: "Down", values: undefined };
  }

  /**
   * ORIGINAL METHOD - Create a new round on the Soroban contract
   * ENHANCED with retry logic and better error handling
   */
  async createRound(
    startPrice: number,
    durationLedgers: number,
    mode?: number,
  ): Promise<string> {
    this.ensureInitialized();

    // Validate mode if provided (NEW)
    if (mode !== undefined && mode !== 0 && mode !== 1) {
      throw new BlockchainError(
        BlockchainErrorType.VALIDATION,
        `Invalid game mode: ${mode}. Must be 0 (UP_DOWN) or 1 (LEGENDS).`,
        false,
      );
    }

    if (mode === 1) {
      throw new BlockchainError(
        BlockchainErrorType.VALIDATION,
        "LEGENDS mode (mode=1) is not yet supported. The Soroban contract currently only supports Up/Down betting.",
        false,
      );
    }

    if (durationLedgers <= 0 || durationLedgers > 10000) {
      throw new BlockchainError(
        BlockchainErrorType.VALIDATION,
        `Invalid duration: ${durationLedgers}. Must be between 1 and 10000 ledgers.`,
        false,
      );
    }

    const priceInStroops = this.priceToStroops(startPrice);
    const operationStart = Date.now();

    try {
      // ORIGINAL LOGIC with retry wrapper (ENHANCED)
      const txHash = await this.retryWithBackoff(async () => {
        return await this.client!.create_round({
          start_price: priceInStroops,
          duration_ledgers: durationLedgers,
        });
      }, "createRound");

      const duration = Date.now() - operationStart;

      logger.info("Round created on Soroban contract", {
        startPrice,
        priceInStroops: priceInStroops.toString(),
        durationLedgers,
        mode: mode ?? 0,
        txHash,
        durationMs: duration,
      });

      return String(txHash);
    } catch (error: any) {
      const duration = Date.now() - operationStart;

      logger.error("Failed to create round on Soroban contract", {
        startPrice,
        durationLedgers,
        mode: mode ?? 0,
        error: error.message,
        errorType: error.type,
        durationMs: duration,
      });

      throw error;
    }
  }

  /**
   * ORIGINAL METHOD - Place a bet on the Soroban contract
   * ENHANCED with retry logic and better error handling
   */
  async placeBet(
    userAddress: string,
    userSecretKey: string,
    amount: bigint,
    side: "UP" | "DOWN",
    mode?: number,
  ): Promise<string> {
    this.ensureInitialized();

    if (mode === 1) {
      throw new BlockchainError(
        BlockchainErrorType.VALIDATION,
        "LEGENDS mode is not yet supported",
        false,
      );
    }

    if (!userAddress || !userAddress.startsWith("G")) {
      throw new BlockchainError(
        BlockchainErrorType.VALIDATION,
        `Invalid user address: ${userAddress}`,
        false,
      );
    }

    if (!userSecretKey || !userSecretKey.startsWith("S")) {
      throw new BlockchainError(
        BlockchainErrorType.VALIDATION,
        "Invalid user secret key provided",
        false,
      );
    }

    if (amount <= 0) {
      throw new BlockchainError(
        BlockchainErrorType.VALIDATION,
        `Invalid bet amount: ${amount}. Must be positive.`,
        false,
      );
    }

    const betSide = this.createBetSide(side);
    const operationStart = Date.now();

    try {
      // ORIGINAL LOGIC with retry wrapper
      const txHash = await this.retryWithBackoff(
        async () => {
          return await this.client!.place_bet({
            user: userAddress,
            amount: amount,
            side: betSide,
          });
        },
        "placeBet",
        { ...DEFAULT_RETRY_CONFIG, maxRetries: 2 }, // Fewer retries for user ops
      );

      const duration = Date.now() - operationStart;

      logger.info("Bet placed on Soroban contract", {
        userAddress: this.maskAddress(userAddress),
        amount: amount.toString(),
        amountXLM: this.stroopsToXLM(amount),
        side,
        mode: mode ?? 0,
        txHash,
        durationMs: duration,
      });

      return String(txHash);
    } catch (error: any) {
      const duration = Date.now() - operationStart;

      logger.error("Failed to place bet on Soroban contract", {
        userAddress: this.maskAddress(userAddress),
        amount: amount.toString(),
        side,
        error: error.message,
        errorType: error.type,
        durationMs: duration,
      });

      throw error;
    }
  }

  /**
   * ORIGINAL METHOD - Resolve a round on the Soroban contract
   * ENHANCED with retry logic
   */
  async resolveRound(finalPrice: number, mode?: number): Promise<string> {
    this.ensureInitialized();

    if (mode === 1) {
      throw new BlockchainError(
        BlockchainErrorType.VALIDATION,
        "LEGENDS mode is not yet supported",
        false,
      );
    }

    const priceInStroops = this.priceToStroops(finalPrice);
    const operationStart = Date.now();

    try {
      // ORIGINAL LOGIC with retry wrapper
      const txHash = await this.retryWithBackoff(async () => {
        return await this.client!.resolve_round({
          final_price: priceInStroops,
        });
      }, "resolveRound");

      const duration = Date.now() - operationStart;

      logger.info("Round resolved on Soroban contract", {
        finalPrice,
        priceInStroops: priceInStroops.toString(),
        mode: mode ?? 0,
        txHash,
        durationMs: duration,
      });

      return String(txHash);
    } catch (error: any) {
      const duration = Date.now() - operationStart;

      logger.error("Failed to resolve round on Soroban contract", {
        finalPrice,
        mode: mode ?? 0,
        error: error.message,
        errorType: error.type,
        durationMs: duration,
      });

      throw error;
    }
  }

  /**
   * ORIGINAL METHOD - Get active round from Soroban contract
   */
  async getActiveRound(): Promise<any> {
    if (!this.initialized) {
      logger.warn("Cannot get active round: SorobanService not initialized");
      return null;
    }

    try {
      const round = await this.retryWithBackoff(
        async () => await this.client!.get_active_round(),
        "getActiveRound",
        { ...DEFAULT_RETRY_CONFIG, maxRetries: 2 },
      );

      logger.debug("Retrieved active round from Soroban contract");
      return round;
    } catch (error: any) {
      logger.error("Failed to get active round", {
        error: error.message,
      });
      return null;
    }
  }

  /**
   * ORIGINAL METHOD - Mint initial tokens for a new user
   */
  async mintInitial(userAddress: string): Promise<number> {
    this.ensureInitialized();

    if (!userAddress || !userAddress.startsWith("G")) {
      throw new BlockchainError(
        BlockchainErrorType.VALIDATION,
        `Invalid user address: ${userAddress}`,
        false,
      );
    }

    try {
      const result = await this.retryWithBackoff(
        async () => await this.client!.mint_initial({ user: userAddress }),
        "mintInitial",
      );

      const amountXLM = this.stroopsToXLM(result);

      logger.info("Minted initial tokens", {
        userAddress: this.maskAddress(userAddress),
        amount: result.toString(),
        amountXLM,
      });

      return amountXLM;
    } catch (error: any) {
      logger.error("Failed to mint initial tokens", {
        userAddress: this.maskAddress(userAddress),
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * ORIGINAL METHOD - Get user balance from Soroban contract
   */
  async getBalance(userAddress: string): Promise<number> {
    if (!this.initialized) {
      logger.warn("Cannot get balance: SorobanService not initialized");
      return 0;
    }

    if (!userAddress || !userAddress.startsWith("G")) {
      logger.warn("Invalid user address for balance check", { userAddress });
      return 0;
    }

    try {
      const balance = await this.retryWithBackoff(
        async () => await this.client!.balance({ user: userAddress }),
        "getBalance",
        { ...DEFAULT_RETRY_CONFIG, maxRetries: 2 },
      );

      const balanceXLM = this.stroopsToXLM(balance);

      logger.debug("Retrieved user balance", {
        userAddress: this.maskAddress(userAddress),
        balance: balance.toString(),
        balanceXLM,
      });

      return balanceXLM;
    } catch (error: any) {
      logger.error("Failed to get user balance", {
        userAddress: this.maskAddress(userAddress),
        error: error.message,
      });
      return 0;
    }
  }

  /**
   * NEW METHOD - Check if service is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * NEW METHOD - Get service status
   */
  getStatus(): {
    initialized: boolean;
    network: string | null;
    contractId: string | null;
    rpcUrl: string | null;
  } {
    return {
      initialized: this.initialized,
      network: this.networkPassphrase,
      contractId: this.initialized
        ? process.env.SOROBAN_CONTRACT_ID || null
        : null,
      rpcUrl: this.rpcUrl,
    };
  }

  /**
   * NEW METHOD - Mask wallet address for privacy
   */
  private maskAddress(address: string): string {
    if (address.length <= 12) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
}

// ORIGINAL EXPORT
export default new SorobanService();