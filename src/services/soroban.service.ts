import { Keypair, Networks, Transaction } from "@stellar/stellar-sdk";
import logger from "../utils/logger";
import { Client, BetSide, OraclePayload, RoundMode } from "@tevalabs/xelma-bindings";

export class SorobanService {
  private client: Client | null = null;
  private adminKeypair: Keypair | null = null;
  private oracleKeypair: Keypair | null = null;
  private initialized = false;

  constructor() {
    try {
      const contractId = process.env.SOROBAN_CONTRACT_ID;
      const network = process.env.SOROBAN_NETWORK || "testnet";
      const rpcUrl =
        process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
      const adminSecret = process.env.SOROBAN_ADMIN_SECRET;
      const oracleSecret = process.env.SOROBAN_ORACLE_SECRET;

      // Hard-disable if anything critical is missing
      if (!contractId || !adminSecret || !oracleSecret) {
        logger.warn(
          "Soroban configuration or bindings missing. Soroban integration DISABLED.",
        );
        return;
      }

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

  private ensureInitialized(): Client {
    if (!this.initialized || !this.client) {
      throw new Error("Soroban service is not initialized");
    }
    return this.client;
  }

  /**
   * Creates a new round on the Soroban contract (admin only).
   * mode: 0 = Up/Down (default), 1 = Precision (Legends)
   */
  async createRound(
    startPrice: number,
    mode: 0 | 1 = RoundMode.UpDown,
  ): Promise<void> {
    const client = this.ensureInitialized();
    try {
      logger.info(
        `Creating Soroban round: price=${startPrice}, mode=${mode}`,
      );

      // Price scaled to 4 decimal places (e.g. 0.2297 → 2297)
      const priceScaled = BigInt(Math.round(startPrice * 10_000));

      const tx = await client.create_round({
        start_price: priceScaled,
        mode,
      });
      await tx.signAndSend({ signTransaction: this.signWithAdmin.bind(this) });

      logger.info("Soroban round created successfully");
    } catch (error) {
      logger.error("Failed to create Soroban round:", error);
      throw new Error(`Soroban contract error: ${error}`);
    }
  }

  /**
   * Places a bet on the Soroban contract (Up/Down mode only).
   */
  async placeBet(
    userAddress: string,
    amount: number,
    side: "UP" | "DOWN",
  ): Promise<void> {
    const client = this.ensureInitialized();
    try {
      logger.info(
        `Placing bet on Soroban: user=${userAddress}, amount=${amount}, side=${side}`,
      );

      // Amount in stroops (1 XLM = 10^7 stroops)
      const amountInStroops = BigInt(Math.floor(amount * 10_000_000));

      const betSide: BetSide =
        side === "UP"
          ? { tag: "Up", values: undefined }
          : { tag: "Down", values: undefined };

      const tx = await client.place_bet({
        user: userAddress,
        amount: amountInStroops,
        side: betSide,
      });
      await tx.signAndSend({ signTransaction: this.signWithAdmin.bind(this) });

      logger.info("Bet placed successfully on Soroban");
    } catch (error) {
      logger.error("Failed to place bet on Soroban:", error);
      throw new Error(`Soroban contract error: ${error}`);
    }
  }

  /**
   * Resolves the active round via oracle payload (oracle only).
   */
  async resolveRound(
    finalPrice: number,
    roundId: number,
    timestamp: bigint,
  ): Promise<void> {
    const client = this.ensureInitialized();
    try {
      logger.info(`Resolving Soroban round: finalPrice=${finalPrice}, roundId=${roundId}`);

      // Price scaled to 4 decimal places
      const priceScaled = BigInt(Math.round(finalPrice * 10_000));

      const payload: OraclePayload = {
        price: priceScaled,
        round_id: roundId,
        timestamp,
      };

      const tx = await client.resolve_round({ payload });
      await tx.signAndSend({ signTransaction: this.signWithOracle.bind(this) });

      logger.info("Soroban round resolved successfully");
    } catch (error) {
      logger.error("Failed to resolve Soroban round:", error);
      throw new Error(`Soroban contract error: ${error}`);
    }
  }

  /**
   * Gets the active round from Soroban (read-only simulation).
   */
  async getActiveRound(): Promise<unknown> {
    if (!this.initialized || !this.client) return null;
    try {
      const tx = await this.client.get_active_round();
      return tx.result;
    } catch (error) {
      logger.error("Failed to get active round from Soroban:", error);
      return null;
    }
  }

  /**
   * Mints 1000 vXLM for a new user (one-time only).
   * Returns the minted amount converted from stroops to XLM.
   */
  async mintInitial(userAddress: string): Promise<number> {
    const client = this.ensureInitialized();
    try {
      const tx = await client.mint_initial({ user: userAddress });
      await tx.signAndSend({ signTransaction: this.signWithAdmin.bind(this) });
      return Number(tx.result) / 10_000_000;
    } catch (error) {
      logger.error("Failed to mint initial tokens:", error);
      throw new Error(`Soroban contract error: ${error}`);
    }
  }

  /**
   * Gets user balance from Soroban (read-only simulation).
   * Returns balance in XLM (converted from stroops).
   */
  async getBalance(userAddress: string): Promise<number> {
    if (!this.initialized || !this.client) return 0;
    try {
      const tx = await this.client.balance({ user: userAddress });
      return Number(tx.result) / 10_000_000;
    } catch (error) {
      logger.error("Failed to get balance from Soroban:", error);
      return 0;
    }
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
