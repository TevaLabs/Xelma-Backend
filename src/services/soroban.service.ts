import { Client, BetSide } from '@tevalabs/xelma-bindings';
import { Keypair, Networks } from '@stellar/stellar-sdk';
import logger from '../utils/logger';

export class SorobanService {
  private client: Client | null = null;
  private adminKeypair: Keypair | null = null;
  private oracleKeypair: Keypair | null = null;
  private initialized = false;

  constructor() {
    try {
      const contractId = process.env.SOROBAN_CONTRACT_ID;
      const network = process.env.SOROBAN_NETWORK || 'testnet';
      const rpcUrl =
        process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
      const adminSecret = process.env.SOROBAN_ADMIN_SECRET;
      const oracleSecret = process.env.SOROBAN_ORACLE_SECRET;

      if (!contractId || !adminSecret || !oracleSecret) {
        logger.warn(
          'Soroban configuration missing. Soroban integration disabled.'
        );
        return;
      }

      this.client = new Client({
        contractId,
        networkPassphrase:
          network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
        rpcUrl,
      });

      this.adminKeypair = Keypair.fromSecret(adminSecret);
      this.oracleKeypair = Keypair.fromSecret(oracleSecret);
      this.initialized = true;

      logger.info('Soroban service initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Soroban service:', error);
    }
  }

  private ensureInitialized() {
    if (!this.initialized || !this.client) {
      throw new Error('Soroban service is not initialized');
    }
  }

  /**
   * Creates a new prediction round
   */
  async createRound(
    startPrice: number,
    durationLedgers: number
  ): Promise<string> {
    this.ensureInitialized();

    try {
      const priceInStroops = Math.floor(startPrice * 10_000_000);

      const result = await this.client!.create_round({
        start_price: BigInt(priceInStroops),
        duration_ledgers: durationLedgers,
      });

      logger.info('Soroban round created');
      return result.toString();
    } catch (error) {
      logger.error('Failed to create Soroban round:', error);
      throw error;
    }
  }

  /**
   * Places a bet
   */
  async placeBet(
    userAddress: string,
    amount: number,
    side: 'UP' | 'DOWN'
  ): Promise<void> {
    this.ensureInitialized();

    try {
      const amountInStroops = Math.floor(amount * 10_000_000);

      const betSide: BetSide =
        side === 'UP'
          ? { tag: 'Up', values: undefined }
          : { tag: 'Down', values: undefined };

      await this.client!.place_bet({
        user: userAddress,
        amount: BigInt(amountInStroops),
        side: betSide,
      });

      logger.info('Bet placed successfully');
    } catch (error) {
      logger.error('Failed to place bet:', error);
      throw error;
    }
  }

  /**
   * Resolves the active round (oracle only)
   */
  async resolveRound(finalPrice: number): Promise<void> {
    this.ensureInitialized();

    try {
      const priceInStroops = Math.floor(finalPrice * 10_000_000);

      await this.client!.resolve_round({
        final_price: BigInt(priceInStroops),
      });

      logger.info('Soroban round resolved');
    } catch (error) {
      logger.error('Failed to resolve round:', error);
      throw error;
    }
  }

  /**
   * Fetch active round
   */
  async getActiveRound(): Promise<any | null> {
    if (!this.initialized) return null;

    try {
      return await this.client!.get_active_round();
    } catch (error) {
      logger.error('Failed to fetch active round:', error);
      return null;
    }
  }

  /**
   * Get user balance
   */
  async getBalance(userAddress: string): Promise<number> {
    if (!this.initialized) return 0;

    try {
      const balance = await this.client!.balance({ user: userAddress });
      return Number(balance) / 10_000_000;
    } catch (error) {
      logger.error('Failed to fetch balance:', error);
      return 0;
    }
  }

  /**
   * Mint initial tokens for a new user
   */
  async mintInitial(userAddress: string): Promise<number> {
    this.ensureInitialized();

    try {
      const result = await this.client!.mint_initial({ user: userAddress });
      return Number(result) / 10_000_000;
    } catch (error) {
      logger.error('Failed to mint initial tokens:', error);
      throw error;
    }
  }
}

export default new SorobanService();
