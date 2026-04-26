import { Keypair, Networks, Transaction } from "@stellar/stellar-sdk";
import type { Client as XelmaClient, BetSide, OraclePayload, RoundMode } from "@tevalabs/xelma-bindings";
import logger from "../utils/logger";
import { toDecimal } from "../utils/decimal.util";
import { withTimeout, TimeoutResult } from "../utils/timeout-wrapper";
import { Decimal } from "@prisma/client/runtime/library";

export interface SorobanHealth {
  initialized: boolean;
  contractId: string | null;
  network: string;
  rpcUrl: string;
  hasAdminKey: boolean;
  hasOracleKey: boolean;
}

/**
 * SorobanService handles interaction with the Stellar Soroban smart contracts.
 * 
 * FAILURE POLICY:
 * This service currently implements a "FAIL-OPEN" policy.
 * If the Soroban integration is not initialized or a contract call fails,
 * the system is designed to log a warning and proceed with database-only 
 * operations where possible, ensuring system availability at the cost 
 * of decentralized verification for those specific operations.
 * 
 * Rounds relying on DB-only fallback are marked with `isSoroban: false`.
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

  constructor() {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    try {
      const contractId = process.env.SOROBAN_CONTRACT_ID;
      const network = process.env.SOROBAN_NETWORK || "testnet";
      const rpcUrl =
        process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
      const adminSecret = process.env.SOROBAN_ADMIN_SECRET;
      const oracleSecret = process.env.SOROBAN_ORACLE_SECRET;

      if (!contractId || !adminSecret || !oracleSecret) {
        logger.warn(
          "Soroban configuration or bindings missing. Soroban integration DISABLED.",
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

      this.adminKeypair = Keypair.fromSecret(adminSecret);
      this.oracleKeypair = Keypair.fromSecret(oracleSecret);
      this.initialized = true;

      logger.info("Soroban service initialized successfully");
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
      contractId: process.env.SOROBAN_CONTRACT_ID || null,
      network: process.env.SOROBAN_NETWORK || "testnet",
      rpcUrl: process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
      hasAdminKey: !!this.adminKeypair,
      hasOracleKey: !!this.oracleKeypair,
    };
  }

  /**
   * Returns true if the service is initialized and ready to use
   */
  isReady(): boolean {
    return this.initialized;
  }

  private async ensureInitialized(): Promise<void> {
    await this.ready;
    if (!this.initialized || !this.client) {
      throw new Error("Soroban service is not initialized");
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
    
    const result = await withTimeout(
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
    );

    if (!result.success) {
      logger.error("Failed to create Soroban round after retries", {
        error: result.error?.message,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      });
      throw new Error(`Soroban contract error: ${result.error?.message}`);
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
  ): Promise<void> {
    await this.ensureInitialized();
    
    const result = await withTimeout(
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
        await tx.signAndSend({ signTransaction: this.signWithAdmin.bind(this) });
        return undefined;
      },
      {
        timeoutMs: this.CALL_TIMEOUT_MS,
        operationName: 'sorobanPlaceBet',
        retries: this.MAX_RETRIES,
      }
    );

    if (!result.success) {
      logger.error("Failed to place bet on Soroban after retries", {
        error: result.error?.message,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      });
      throw new Error(`Soroban contract error: ${result.error?.message}`);
    }

    logger.info("Bet placed successfully on Soroban", {
      durationMs: result.durationMs,
      retriesUsed: result.retriesUsed,
    });
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
    
    const result = await withTimeout(
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
    );

    if (!result.success) {
      logger.error("Failed to resolve Soroban round after retries", {
        error: result.error?.message,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      });
      throw new Error(`Soroban contract error: ${result.error?.message}`);
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
    
    const result = await withTimeout(
      async () => {
        const tx = await this.client!.get_active_round();
        return tx.result;
      },
      {
        timeoutMs: 10000, // Shorter timeout for read-only
        operationName: 'sorobanGetActiveRound',
        retries: 1, // Only retry once for read-only
      }
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
    
    const result = await withTimeout(
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
    );

    if (!result.success) {
      logger.error("Failed to mint initial tokens after retries", {
        error: result.error?.message,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      });
      throw new Error(`Soroban contract error: ${result.error?.message}`);
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
    
    const result = await withTimeout(
      async () => {
        const tx = await this.client!.balance({ user: userAddress });
        return Number(tx.result) / 10_000_000;
      },
      {
        timeoutMs: 10000, // Shorter timeout for read-only
        operationName: 'sorobanGetBalance',
        retries: 1, // Only retry once for read-only
      }
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

  // ---------------------------------------------------------------------------
  // Internal signing helpers
  // ---------------------------------------------------------------------------

  private signWithAdmin(xdr: string): string {
    if (!this.adminKeypair) throw new Error("Admin keypair not set");
    const network = process.env.SOROBAN_NETWORK || "testnet";
    const passphrase =
      network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
    const tx = new Transaction(xdr, passphrase);
    tx.sign(this.adminKeypair);
    return tx.toEnvelope().toXDR("base64");
  }

  private signWithOracle(xdr: string): string {
    if (!this.oracleKeypair) throw new Error("Oracle keypair not set");
    const network = process.env.SOROBAN_NETWORK || "testnet";
    const passphrase =
      network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
    const tx = new Transaction(xdr, passphrase);
    tx.sign(this.oracleKeypair);
    return tx.toEnvelope().toXDR("base64");
  }
}

export default new SorobanService();
