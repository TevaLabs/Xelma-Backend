import { Keypair, Networks, Transaction } from "@stellar/stellar-sdk";
import type { Client as XelmaClient, BetSide, OraclePayload, RoundMode, UserStats, contract } from "@tevalabs/xelma-bindings";
import config from "../config";
import logger from "../utils/logger";
import { toDecimal } from "../utils/decimal.util";
import { stroopsToXlm } from "../utils/payout.util";
import { withTimeout, TimeoutResult } from "../utils/timeout-wrapper";
import { CircuitBreaker, CircuitBreakerOpenError } from "../utils/circuit-breaker";
import { createConcurrencyLimiter } from "../utils/backpressure";
import { BackpressureError } from "../utils/errors";
import { Decimal } from "@prisma/client/runtime/library";
import { mapSorobanError } from "../utils/errors";
import {
  sorobanRpcCallsTotal,
  sorobanRpcDurationSeconds,
} from "../metrics/application.metrics";

export interface SorobanHealth {
  initialized: boolean;
  contractId: string | null;
  network: string;
  rpcUrl: string;
  hasAdminKey: boolean;
  hasOracleKey: boolean;
  failClosed: boolean;
}

export interface TransactionStatus {
  confirmed: boolean;
  successful: boolean;
  ledger?: number;
  feeCharged?: number;
  error?: string;
}

/**
 * Shape of a successfully claimed `claim_winnings` transaction, derived
 * from the `SentTransaction<bigint>` returned by the generated bindings'
 * `claim_winnings` client method (see `claim_winnings: (json: string) =>
 * AssembledTransaction<bigint>` in @tevalabs/xelma-bindings).
 */
export interface ClaimResult {
  state: "on-chain-success";
  amount: number;
  txHash?: string;
}

/** Thrown when a `claim_winnings` response does not have the shape the contract promises. */
export class InvalidClaimResultError extends Error {
  constructor(reason: string) {
    super(`Invalid Soroban claim_winnings result: ${reason}`);
    this.name = "InvalidClaimResultError";
  }
}

/**
 * Safely parses a sent `claim_winnings` transaction into a {@link ClaimResult}.
 * `sent.result` is typed as `bigint` by the generated bindings, but since it
 * ultimately comes from parsed RPC/XDR data we still validate it at runtime
 * before trusting it, rather than casting past the type system.
 */
export function parseClaimResult(
  sent: contract.SentTransaction<bigint>,
): ClaimResult {
  const claimedStroops = sent.result;

  if (typeof claimedStroops !== "bigint") {
    throw new InvalidClaimResultError(
      `expected a bigint result, received ${typeof claimedStroops}`,
    );
  }
  if (claimedStroops < BigInt(0)) {
    throw new InvalidClaimResultError(
      `claimed amount must not be negative, received ${claimedStroops}`,
    );
  }

  return {
    state: "on-chain-success",
    amount: stroopsToXlm(claimedStroops),
    txHash: sent.sendTransactionResponse?.hash,
  };
}

/**
 * SorobanService handles interaction with the Stellar Soroban smart contracts.
 *
 * FAILURE POLICY (configurable via SOROBAN_FAIL_CLOSED):
 * - Fail-open (default, demos/local): if Soroban is unavailable or a contract
 *   call fails on money paths, callers may log a warning and continue with
 *   database-only operations. Rounds using DB-only fallback are marked
 *   `isSoroban: false`.
 * - Fail-closed (recommended for production): money paths (bet/resolve) abort
 *   when chain verification fails so silent skip of on-chain checks is impossible.
 *
 * TIMEOUT POLICY:
 * All contract calls have bounded timeouts with automatic retry logic.
 * Slow or hanging upstream responses are aborted and retried.
 */
export class SorobanService {
  private client: XelmaClient | null = null;
  private adminKeypair: Keypair | null = null;
  private oracleKeypair: Keypair | null = null;
  private initialized = false;
  private readonly ready: Promise<void>;
  private readonly CALL_TIMEOUT_MS = 15000; // 15s timeout for contract calls
  private readonly MAX_RETRIES = 2; // 2 retries for transient failures
  private readonly breaker = new CircuitBreaker({
    name: "soroban-rpc",
    failureThreshold: config.soroban.breakerFailureThreshold,
    openBackoffMs: config.soroban.breakerOpenBackoffMs,
  });
  private readonly rpcLimiter = createConcurrencyLimiter({
    name: "soroban-rpc",
    maxInFlight: config.soroban.moneyPathMaxInFlight,
    retryAfterSeconds: 1,
  });

  constructor() {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    try {
      const contractId = config.soroban.contractId;
      const network = config.soroban.network;
      const rpcUrl = config.soroban.rpcUrl;
      const adminSecret = config.soroban.adminSecret;
      const oracleSecret = config.soroban.oracleSecret;

      if (!contractId) {
        logger.warn(
          "SOROBAN_CONTRACT_ID (or alias CONTRACT_ID) not set. Soroban integration DISABLED.",
        );
        this.initialized = false;
        return;
      }

      const { Client } = await import("@tevalabs/xelma-bindings");
      this.client = new Client({
        contractId,
        networkPassphrase:
          network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET,
        rpcUrl,
      });

      if (adminSecret && oracleSecret) {
        this.adminKeypair = Keypair.fromSecret(adminSecret);
        this.oracleKeypair = Keypair.fromSecret(oracleSecret);
        logger.info("Soroban service initialized (read-write)");
      } else {
        logger.info(
          "Soroban service initialized (read-only; write keys not configured)",
        );
      }

      this.initialized = true;
    } catch (error) {
      logger.error("Failed to initialize Soroban service:", error);
      this.initialized = false;
    }
  }

  /**
   * Returns the current health status of the Soroban service
   */
  async getHealth(): Promise<SorobanHealth> {
    await this.ready;
    return {
      initialized: this.initialized,
      contractId: config.soroban.contractId || null,
      network: config.soroban.network,
      rpcUrl: config.soroban.rpcUrl,
      hasAdminKey: !!this.adminKeypair,
      hasOracleKey: !!this.oracleKeypair,
      failClosed: this.isFailClosed(),
    };
  }

  /**
   * Returns true if the service is initialized and ready to use
   */
  isReady(): boolean {
    return this.initialized;
  }

  /**
   * True when money paths must abort if chain verification fails.
   * Driven by SOROBAN_FAIL_CLOSED (default false = fail-open).
   */
  isFailClosed(): boolean {
    return config.soroban.failClosed;
  }

  /**
   * Apply the configured money-path failure policy after a Soroban call fails.
   * Fail-closed: rethrows so the caller aborts bet/resolve (or related) work.
   * Fail-open: logs a warning and returns so the caller may continue DB-only.
   */
  applyMoneyPathFailure(operation: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.isFailClosed()) {
      logger.error(
        `Soroban ${operation} failed (fail-closed); aborting money path`,
        { error: message },
      );
      throw error instanceof Error ? error : new Error(message);
    }
    logger.warn(
      `Soroban ${operation} failed (fail-open); proceeding without chain verification`,
      { error: message },
    );
  }

  private async ensureInitialized(): Promise<void> {
    await this.ready;
    if (!this.initialized || !this.client) {
      throw new Error("Soroban service is not initialized");
    }
  }

  private async callWithBreaker<T>(
    operationName: string,
    operation: () => Promise<TimeoutResult<T>>,
    fallback?: T,
  ): Promise<TimeoutResult<T>> {
    const startMs = Date.now();

    try {
      const result = await this.rpcLimiter.execute(() =>
        this.breaker.execute(async () => {
          const timeoutResult = await operation();
          if (!timeoutResult.success) {
            throw timeoutResult.error ?? new Error(`${operationName} failed`);
          }
          return timeoutResult;
        }),
      );

      const latencySeconds = (Date.now() - startMs) / 1000;
      sorobanRpcDurationSeconds.observe({ operation: operationName }, latencySeconds);
      sorobanRpcCallsTotal.inc({ operation: operationName, outcome: "success" });

      return result;
    } catch (error) {
      const latencySeconds = (Date.now() - startMs) / 1000;
      sorobanRpcDurationSeconds.observe({ operation: operationName }, latencySeconds);

      if (error instanceof BackpressureError) {
        throw error;
      }

      if (error instanceof CircuitBreakerOpenError) {
        sorobanRpcCallsTotal.inc({ operation: operationName, outcome: "breaker_open" });

        logger.warn("Skipped Soroban call because circuit breaker is open", {
          operationName,
          breaker: error.breakerName,
          nextAttemptAt: error.nextAttemptAt.toISOString(),
        });

        return {
          success: false,
          data: fallback,
          error,
          durationMs: 0,
          retriesUsed: 0,
          timedOut: false,
        };
      }

      sorobanRpcCallsTotal.inc({ operation: operationName, outcome: "failure" });

      if (error instanceof Error) {
        return {
          success: false,
          error,
          durationMs: 0,
          retriesUsed: 0,
          timedOut: error.message.includes("timeout"),
        };
      }

      return {
        success: false,
        error: new Error(String(error)),
        durationMs: 0,
        retriesUsed: 0,
        timedOut: false,
      };
    }
  }

  /**
   * Creates a new round on the Soroban contract (admin only).
   * mode: 0 = Up/Down (default), 1 = Precision (Legends)
   * 
   * Uses timeout wrapper with retry logic to handle slow/hanging responses.
   */
  async createRound(
    startPrice: number | string | Decimal,
    mode: RoundMode = 0 as RoundMode,
  ): Promise<void> {
    await this.ensureInitialized();
    
    const result = await this.callWithBreaker("sorobanCreateRound", () =>
      withTimeout(
        async () => {
        logger.debug(
          `Initiating Soroban createRound: price=${startPrice}, mode=${mode}`,
        );

        // Price scaled to 4 decimal places (e.g. 0.2297 → 2297)
        const priceScaled = BigInt(toDecimal(startPrice).mul(10_000).toFixed(0));

        const tx = await this.client!.create_round({
          start_price: priceScaled,
          mode,
        });
        await tx.signAndSend({ signTransaction: this.signWithAdmin.bind(this) });
        return undefined;
      },
      {
        timeoutMs: this.CALL_TIMEOUT_MS,
        operationName: 'sorobanCreateRound',
        retries: this.MAX_RETRIES,
      }
      )
    );

    if (!result.success) {
      logger.error("Failed to create Soroban round after retries", {
        error: result.error?.message,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      });
      throw mapSorobanError(result.error?.message);
    }

    logger.info("Soroban round created successfully", {
      durationMs: result.durationMs,
      retriesUsed: result.retriesUsed,
    });
  }

  /**
   * Places a bet on the Soroban contract (Up/Down mode only).
   * 
   * Uses timeout wrapper with retry logic.
   */
  async placeBet(
    userAddress: string,
    amount: number | string,
    side: "UP" | "DOWN",
  ): Promise<{ state: string; txHash?: string }> {
    await this.ensureInitialized();
    
    const result = await this.callWithBreaker("sorobanPlaceBet", () =>
      withTimeout(
        async () => {
        logger.debug(
          `Initiating Soroban placeBet: user=${userAddress}, amount=${amount}, side=${side}`,
        );

        // Amount in stroops (1 XLM = 10^7 stroops)
        const amountInStroops = BigInt(toDecimal(amount).mul(10_000_000).toFixed(0));

        const betSide: BetSide =
          side === "UP"
            ? { tag: "Up", values: undefined }
            : { tag: "Down", values: undefined };

        const tx = await this.client!.place_bet({
          user: userAddress,
          amount: amountInStroops,
          side: betSide,
        });
        const res = await tx.signAndSend({ signTransaction: this.signWithAdmin.bind(this) });
        // Return a generic state, or the tx hash if the bindings expose it
        return { state: "on-chain-success", txHash: (res as any).hash };
      },
      {
        timeoutMs: this.CALL_TIMEOUT_MS,
        operationName: 'sorobanPlaceBet',
        retries: this.MAX_RETRIES,
      }
      )
    );

    if (!result.success) {
      logger.error("Failed to place bet on Soroban after retries", {
        error: result.error?.message,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      });
      throw mapSorobanError(result.error?.message);
    }

    logger.info("Bet placed successfully on Soroban", {
      durationMs: result.durationMs,
      retriesUsed: result.retriesUsed,
    });

    return result.data!;
  }

  /**
   * Places a precision prediction on the Soroban contract.
   * 
   * Uses timeout wrapper with retry logic.
   */
  async placePrecisionBet(
    userAddress: string,
    amount: number | string,
    predictedPrice: number | string,
  ): Promise<{ state: string; txHash?: string }> {
    await this.ensureInitialized();
    
    const result = await this.callWithBreaker("sorobanPlacePrecisionBet", () =>
      withTimeout(
        async () => {
        logger.debug(
          `Initiating Soroban placePrecisionBet: user=${userAddress}, amount=${amount}, predictedPrice=${predictedPrice}`,
        );

        // Amount in stroops (1 XLM = 10^7 stroops)
        const amountInStroops = BigInt(toDecimal(amount).mul(10_000_000).toFixed(0));
        
        // Price scaled to 4 decimal places
        const priceScaled = BigInt(toDecimal(predictedPrice).mul(10_000).toFixed(0));

        const tx = await this.client!.place_precision_prediction({
          user: userAddress,
          amount: amountInStroops,
          predicted_price: priceScaled,
        });
        const res = await tx.signAndSend({ signTransaction: this.signWithAdmin.bind(this) });
        return { state: "on-chain-success", txHash: (res as any).hash };
      },
      {
        timeoutMs: this.CALL_TIMEOUT_MS,
        operationName: 'sorobanPlacePrecisionBet',
        retries: this.MAX_RETRIES,
      }
      )
    );

    if (!result.success) {
      logger.error("Failed to place precision bet on Soroban after retries", {
        error: result.error?.message,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      });
      throw mapSorobanError(result.error?.message);
    }

    logger.info("Precision bet placed successfully on Soroban", {
      durationMs: result.durationMs,
      retriesUsed: result.retriesUsed,
    });

    return result.data!;
  }

  /**
   * Resolves the active round via oracle payload (oracle only).
   * 
   * Uses timeout wrapper with retry logic.
   */
  async resolveRound(
    finalPrice: number | string | Decimal,
    roundId: number,
    timestamp: bigint,
  ): Promise<void> {
    await this.ensureInitialized();
    
    const result = await this.callWithBreaker("sorobanResolveRound", () =>
      withTimeout(
        async () => {
        logger.debug(
          `Initiating Soroban resolveRound: finalPrice=${finalPrice}, roundId=${roundId}`,
        );

        // Price scaled to 4 decimal places
        const priceScaled = BigInt(toDecimal(finalPrice).mul(10_000).toFixed(0));

        const payload: OraclePayload = {
          price: priceScaled,
          round_id: roundId,
          timestamp,
        };

        const tx = await this.client!.resolve_round({ payload });
        await tx.signAndSend({ signTransaction: this.signWithOracle.bind(this) });
        return undefined;
      },
      {
        timeoutMs: this.CALL_TIMEOUT_MS,
        operationName: 'sorobanResolveRound',
        retries: this.MAX_RETRIES,
      }
      )
    );

    if (!result.success) {
      logger.error("Failed to resolve Soroban round after retries", {
        error: result.error?.message,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      });
      throw mapSorobanError(result.error?.message);
    }

    logger.info("Soroban round resolved successfully", {
      durationMs: result.durationMs,
      retriesUsed: result.retriesUsed,
    });
  }

  /**
   * Gets the active round from Soroban (read-only simulation).
   * 
   * Timeout: 10s for read-only queries (faster than write operations)
   */
  async getActiveRound(): Promise<any> {
    await this.ready;
    if (!this.initialized) return null;
    
    const result = await this.callWithBreaker("sorobanGetActiveRound", () =>
      withTimeout(
        async () => {
        const tx = await this.client!.get_active_round();
        return tx.result;
      },
      {
        timeoutMs: 10000, // Shorter timeout for read-only
        operationName: 'sorobanGetActiveRound',
        retries: 1, // Only retry once for read-only
      }
      ),
      null,
    );

    if (!result.success) {
      logger.warn("Failed to get active round from Soroban", {
        error: result.error?.message,
        timedOut: result.timedOut,
      });
      return null;
    }

    return result.data;
  }

  /**
   * Mints 1000 vXLM for a new user (one-time only).
   * Returns the minted amount converted from stroops to XLM.
   * 
   * Uses timeout wrapper with retry logic.
   */
  async mintInitial(userAddress: string): Promise<number> {
    await this.ensureInitialized();
    
    const result = await this.callWithBreaker("sorobanMintInitial", () =>
      withTimeout(
        async () => {
        logger.debug(`Initiating Soroban mintInitial: user=${userAddress}`);
        const tx = await this.client!.mint_initial({ user: userAddress });
        await tx.signAndSend({ signTransaction: this.signWithAdmin.bind(this) });
        return Number(tx.result) / 10_000_000;
      },
      {
        timeoutMs: this.CALL_TIMEOUT_MS,
        operationName: 'sorobanMintInitial',
        retries: this.MAX_RETRIES,
      }
      )
    );

    if (!result.success) {
      logger.error("Failed to mint initial tokens after retries", {
        error: result.error?.message,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      });
      throw mapSorobanError(result.error?.message);
    }

    logger.info("Initial tokens minted successfully", {
      amount: result.data,
      durationMs: result.durationMs,
    });

    return result.data!;
  }

  /**
   * Gets user balance from Soroban (read-only simulation).
   * Returns balance in XLM (converted from stroops).
   * 
   * Timeout: 10s for read-only queries
   */
  async getBalance(userAddress: string): Promise<number> {
    await this.ready;
    if (!this.initialized) return 0;
    
    const result = await this.callWithBreaker("sorobanGetBalance", () =>
      withTimeout(
        async () => {
        const tx = await this.client!.balance({ user: userAddress });
        return Number(tx.result) / 10_000_000;
      },
      {
        timeoutMs: 10000, // Shorter timeout for read-only
        operationName: 'sorobanGetBalance',
        retries: 1, // Only retry once for read-only
      }
      ),
      0,
    );

    if (!result.success) {
      logger.warn("Failed to get balance from Soroban", {
        error: result.error?.message,
        timedOut: result.timedOut,
      });
      return 0;
    }

    return result.data!;
  }

  /**
   * Gets user stats from Soroban (read-only simulation).
   * Returns win/loss counts and streak data from the contract.
   *
   * Timeout: 10s for read-only queries
   */
  async getUserStats(userAddress: string): Promise<UserStats | null> {
    await this.ready;
    if (!this.initialized) return null;

    const result = await this.callWithBreaker("sorobanGetUserStats", () =>
      withTimeout(
        async () => {
          const tx = await this.client!.get_user_stats({ user: userAddress });
          return tx.result;
        },
        {
          timeoutMs: 10000,
          operationName: 'sorobanGetUserStats',
          retries: 1,
        }
      ),
      null,
    );

    if (!result.success) {
      logger.warn("Failed to get user stats from Soroban", {
        error: result.error?.message,
        timedOut: result.timedOut,
      });
      return null;
    }

    return result.data;
  }

  /**
   * Gets pending (claimable) winnings from Soroban (read-only simulation).
   * Returns the amount in stroops (1 XLM = 10^7 stroops).
   *
   * Timeout: 10s for read-only queries
   */
  async getPendingWinnings(userAddress: string): Promise<bigint> {
    await this.ready;
    if (!this.initialized) return BigInt(0);

    const result = await this.callWithBreaker("sorobanGetPendingWinnings", () =>
      withTimeout(
        async () => {
          const tx = await this.client!.get_pending_winnings({ user: userAddress });
          return tx.result;
        },
        {
          timeoutMs: 10000,
          operationName: 'sorobanGetPendingWinnings',
          retries: 1,
        }
      ),
      BigInt(0),
    );

    if (!result.success) {
      logger.warn("Failed to get pending winnings from Soroban", {
        error: result.error?.message,
        timedOut: result.timedOut,
      });
      return BigInt(0);
    }

    return result.data!;
  }

  /**
   * Claims pending winnings on the Soroban contract and credits the user's balance.
   * Returns the claimed amount in XLM (converted from stroops) plus optional tx hash.
   *
   * Uses timeout wrapper with retry logic. Signed by the admin keypair (backend relay).
   */
  async claimWinnings(userAddress: string): Promise<ClaimResult> {
    await this.ensureInitialized();

    const result = await this.callWithBreaker("sorobanClaimWinnings", () =>
      withTimeout(
        async () => {
          logger.debug(`Initiating Soroban claimWinnings: user=${userAddress}`);

          const tx = await this.client!.claim_winnings({ user: userAddress });
          const res = await tx.signAndSend({
            signTransaction: this.signWithAdmin.bind(this),
          });

          return parseClaimResult(res);
        },
        {
          timeoutMs: this.CALL_TIMEOUT_MS,
          operationName: "sorobanClaimWinnings",
          retries: this.MAX_RETRIES,
        },
      ),
    );

    if (!result.success) {
      logger.error("Failed to claim winnings on Soroban after retries", {
        error: result.error?.message,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      });
      throw mapSorobanError(result.error?.message);
    }

    logger.info("Winnings claimed successfully on Soroban", {
      amount: result.data?.amount,
      durationMs: result.durationMs,
      retriesUsed: result.retriesUsed,
    });

    return result.data!;
  }

  /**
   * Checks the status of a transaction by its hash.
   * Used for reconciliation of stranded SUBMITTED bets.
   */
  async getTransactionStatus(txHash: string): Promise<TransactionStatus> {
    await this.ensureInitialized();

    const result = await this.callWithBreaker("sorobanGetTransactionStatus", () =>
      withTimeout(
        async () => {
          logger.debug(`Checking Soroban transaction status: ${txHash}`);

          // Use the RPC to get transaction details
          const rpcUrl = config.soroban.rpcUrl;
          const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'getTransaction',
              params: { hash: txHash },
            }),
          });

          const data = await response.json();

          if (data.error) {
            return {
              confirmed: false,
              successful: false,
              error: data.error.message,
            };
          }

          const txResult = data.result;
          if (!txResult) {
            return {
              confirmed: false,
              successful: false,
              error: 'Transaction not found',
            };
          }

          // Check if transaction is successful (status === "SUCCESS")
          const status = txResult.status;
          const successful = status === 'SUCCESS';
          const confirmed = status !== 'NOT_FOUND' && status !== 'PENDING';

          return {
            confirmed,
            successful,
            ledger: txResult.ledger ? parseInt(txResult.ledger, 10) : undefined,
            feeCharged: txResult.feeCharged ? parseInt(txResult.feeCharged, 10) : undefined,
            error: successful ? undefined : txResult.resultXdr ? 'Transaction failed' : undefined,
          };
        },
        {
          timeoutMs: 10000,
          operationName: 'sorobanGetTransactionStatus',
          retries: 1,
        }
      ),
      { confirmed: false, successful: false, error: 'RPC call failed' },
    );

    if (!result.success) {
      logger.warn('Failed to get transaction status from Soroban', {
        txHash,
        error: result.error?.message,
        timedOut: result.timedOut,
      });
      return { confirmed: false, successful: false, error: result.error?.message ?? 'Unknown error' };
    }

    return result.data!;
  }

  // ---------------------------------------------------------------------------
  // Internal signing helpers
  // ---------------------------------------------------------------------------

  private signWithAdmin(xdr: string): string {
    if (!this.adminKeypair) throw new Error("Admin keypair not set");
    const network = config.soroban.network;
    const passphrase =
      network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
    const tx = new Transaction(xdr, passphrase);
    tx.sign(this.adminKeypair);
    return tx.toEnvelope().toXDR("base64");
  }

  private signWithOracle(xdr: string): string {
    if (!this.oracleKeypair) throw new Error("Oracle keypair not set");
    const network = config.soroban.network;
    const passphrase =
      network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
    const tx = new Transaction(xdr, passphrase);
    tx.sign(this.oracleKeypair);
    return tx.toEnvelope().toXDR("base64");
  }
}

export default new SorobanService();
