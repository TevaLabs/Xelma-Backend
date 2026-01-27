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
            const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
            const adminSecret = process.env.SOROBAN_ADMIN_SECRET;
            const oracleSecret = process.env.SOROBAN_ORACLE_SECRET;

            if (contractId && adminSecret && oracleSecret) {
                this.client = new Client({
                    contractId,
                    networkPassphrase: network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
                    rpcUrl,
                });

                this.adminKeypair = Keypair.fromSecret(adminSecret);
                this.oracleKeypair = Keypair.fromSecret(oracleSecret);
                this.initialized = true;
                logger.info('Soroban service initialized');
            } else {
                logger.warn('Soroban configuration missing. Soroban integration will be disabled.');
            }
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
     * Creates a new round on the Soroban contract
     */
    async createRound(startPrice: number, durationLedgers: number): Promise<string> {
        this.ensureInitialized();
        try {
            logger.info(`Creating Soroban round: price=${startPrice}, duration=${durationLedgers}`);

            // Convert price to stroops (1 XLM = 10^7 stroops)
            const priceInStroops = Math.floor(startPrice * 10_000_000);

            const result = await this.client!.create_round({
                start_price: BigInt(priceInStroops),
                duration_ledgers: durationLedgers,
            });

            logger.info('Soroban round created successfully');
            return result.toString();
        } catch (error) {
            logger.error('Failed to create Soroban round:', error);
            throw new Error(`Soroban contract error: ${error}`);
        }
    }

    /**
     * Places a bet on the Soroban contract
     */
    async placeBet(
        userAddress: string,
        amount: number,
        side: 'UP' | 'DOWN'
    ): Promise<void> {
        this.ensureInitialized();
        try {
            logger.info(`Placing bet on Soroban: user=${userAddress}, amount=${amount}, side=${side}`);

            // Convert amount to stroops
            const amountInStroops = Math.floor(amount * 10_000_000);

            // BetSide is a type union: {tag: "Up", values: void} | {tag: "Down", values: void}
            const betSide: BetSide = side === 'UP'
                ? { tag: 'Up', values: undefined }
                : { tag: 'Down', values: undefined };

            await this.client!.place_bet({
                user: userAddress,
                amount: BigInt(amountInStroops),
                side: betSide,
            });

            logger.info('Bet placed successfully on Soroban');
        } catch (error) {
            logger.error('Failed to place bet on Soroban:', error);
            throw new Error(`Soroban contract error: ${error}`);
        }
    }

    /**
     * Resolves a round on the Soroban contract
     */
    async resolveRound(finalPrice: number): Promise<void> {
        this.ensureInitialized();
        try {
            logger.info(`Resolving Soroban round: finalPrice=${finalPrice}`);

            // Convert price to stroops
            const priceInStroops = Math.floor(finalPrice * 10_000_000);

            await this.client!.resolve_round({
                final_price: BigInt(priceInStroops),
            });

            logger.info('Soroban round resolved successfully');
        } catch (error) {
            logger.error('Failed to resolve Soroban round:', error);
            throw new Error(`Soroban contract error: ${error}`);
        }
    }

    /**
     * Gets the active round from Soroban
     */
    async getActiveRound(): Promise<any> {
        if (!this.initialized) return null;
        try {
            const round = await this.client!.get_active_round();
            return round;
        } catch (error) {
            logger.error('Failed to get active round from Soroban:', error);
            return null;
        }
    }

    /**
     * Mints initial tokens for a new user
     */
    async mintInitial(userAddress: string): Promise<number> {
        this.ensureInitialized();
        try {
            const result = await this.client!.mint_initial({ user: userAddress });
            // Convert from stroops to XLM
            return Number(result) / 10_000_000;
        } catch (error) {
            logger.error('Failed to mint initial tokens:', error);
            throw new Error(`Soroban contract error: ${error}`);
        }
    }

    /**
     * Gets user balance from Soroban
     */
    async getBalance(userAddress: string): Promise<number> {
        if (!this.initialized) return 0;
        try {
            const balance = await this.client!.balance({ user: userAddress });
            // Convert from stroops to XLM
            return Number(balance) / 10_000_000;
        } catch (error) {
            logger.error('Failed to get balance from Soroban:', error);
            return 0;
        }
    }
}

export default new SorobanService();
