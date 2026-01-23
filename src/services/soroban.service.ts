import * as StellarSdk from '@stellar/stellar-sdk';
import { GameMode, BetSide } from '../types/round.types';

const CONTRACT_ID = process.env.CONTRACT_ID || '';
const RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || '';
const ORACLE_SECRET_KEY = process.env.ORACLE_SECRET_KEY || '';

const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK === 'mainnet'
  ? StellarSdk.Networks.PUBLIC
  : StellarSdk.Networks.TESTNET;

export class SorobanService {
  private rpc: StellarSdk.SorobanRpc.Server;
  private adminKeypair: StellarSdk.Keypair;
  private oracleKeypair: StellarSdk.Keypair;

  constructor() {
    if (!CONTRACT_ID || CONTRACT_ID === 'your-contract-id-here') {
      console.warn('CONTRACT_ID not configured. Soroban calls will fail.');
    }

    this.rpc = new StellarSdk.SorobanRpc.Server(RPC_URL);
    
    if (ADMIN_SECRET_KEY) {
      this.adminKeypair = StellarSdk.Keypair.fromSecret(ADMIN_SECRET_KEY);
    }
    
    if (ORACLE_SECRET_KEY) {
      this.oracleKeypair = StellarSdk.Keypair.fromSecret(ORACLE_SECRET_KEY);
    }
  }

  private async getAccount(keypair: StellarSdk.Keypair) {
    return await this.rpc.getAccount(keypair.publicKey());
  }

  private async buildTransaction(
    keypair: StellarSdk.Keypair,
    contractMethod: string,
    params: any[]
  ): Promise<StellarSdk.TransactionBuilder> {
    const account = await this.getAccount(keypair);
    const contract = new StellarSdk.Contract(CONTRACT_ID);

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call(contractMethod, ...params))
      .setTimeout(30);

    return tx;
  }

  private async simulateAndSign(
    keypair: StellarSdk.Keypair,
    tx: StellarSdk.TransactionBuilder
  ): Promise<StellarSdk.Transaction> {
    const transaction = tx.build();
    
    const sim = await this.rpc.simulateTransaction(transaction);
    
    if (!sim.result) {
      throw new Error('Transaction simulation failed: No result returned');
    }

    if (SorobanApi.isTransactionError(sim)) {
      throw new Error(`Transaction error: ${sim.error}`);
    }

    transaction.sign(keypair);

    if (sim.result && sim.restorePreamble) {
      const auth = StellarSdk.xdr.SorobanAuthorizationEntry.fromXDR(
        Buffer.from(sim.restorePreamble, 'base64')
      );
      transaction.signAuthXDR(auth.toXDR());
    }

    return transaction;
  }

  async createRound(
    startPrice: bigint,
    durationLedgers: number,
    mode: GameMode
  ): Promise<string> {
    if (mode === GameMode.LEGENDS) {
      throw new Error(
        'LEGENDS_NOT_IMPLEMENTED: The Soroban contract does not yet support Legends mode. ' +
        'Contract update required in Xelma-Blockchain repository. ' +
        'See: https://github.com/TevaLabs/Xelma-Blockchain'
      );
    }

    if (!this.adminKeypair) {
      throw new Error('ADMIN_SECRET_KEY not configured');
    }

    const priceScVal = StellarSdk.scValToBigInt(StellarSdk.ScVal.scvU128(startPrice));
    const durationScVal = StellarSdk.ScVal.scvU32(durationLedgers);

    const tx = await this.buildTransaction(
      this.adminKeypair,
      'create_round',
      [priceScVal, durationScVal]
    );

    const signedTx = await this.simulateAndSign(this.adminKeypair, tx);
    const result = await this.rpc.sendTransaction(signedTx);

    if (result.status === 'PENDING') {
      await this.waitUntilReady(result.hash);
      return result.hash;
    } else {
      throw new Error(`Failed to create round: ${result.status}`);
    }
  }

  async placeBet(
    userAddress: string,
    userSecretKey: string,
    amount: bigint,
    side: BetSide,
    mode: GameMode
  ): Promise<string> {
    if (mode === GameMode.LEGENDS) {
      throw new Error(
        'LEGENDS_NOT_IMPLEMENTED: The Soroban contract does not yet support Legends mode. ' +
        'Contract update required in Xelma-Blockchain repository. ' +
        'See: https://github.com/TevaLabs/Xelma-Blockchain'
      );
    }

    const userKeypair = StellarSdk.Keypair.fromSecret(userSecretKey);

    const addressScVal = StellarSdk.ScVal.scvAddress(StellarSdk.Address.fromString(userAddress));
    const amountScVal = StellarSdk.scValToBigInt(StellarSdk.ScVal.scvI128(amount));
    const sideScVal = StellarSdk.ScVal.scvEnum(
      side === BetSide.UP ? 0 : 1
    );

    const tx = await this.buildTransaction(
      userKeypair,
      'place_bet',
      [addressScVal, amountScVal, sideScVal]
    );

    const signedTx = await this.simulateAndSign(userKeypair, tx);
    const result = await this.rpc.sendTransaction(signedTx);

    if (result.status === 'PENDING') {
      await this.waitUntilReady(result.hash);
      return result.hash;
    } else {
      throw new Error(`Failed to place bet: ${result.status}`);
    }
  }

  async resolveRound(
    finalPrice: bigint,
    mode: GameMode
  ): Promise<string> {
    if (mode === GameMode.LEGENDS) {
      throw new Error(
        'LEGENDS_NOT_IMPLEMENTED: The Soroban contract does not yet support Legends mode. ' +
        'Contract update required in Xelma-Blockchain repository. ' +
        'See: https://github.com/TevaLabs/Xelma-Blockchain'
      );
    }

    if (!this.oracleKeypair) {
      throw new Error('ORACLE_SECRET_KEY not configured');
    }

    const priceScVal = StellarSdk.scValToBigInt(StellarSdk.ScVal.scvU128(finalPrice));

    const tx = await this.buildTransaction(
      this.oracleKeypair,
      'resolve_round',
      [priceScVal]
    );

    const signedTx = await this.simulateAndSign(this.oracleKeypair, tx);
    const result = await this.rpc.sendTransaction(signedTx);

    if (result.status === 'PENDING') {
      await this.waitUntilReady(result.hash);
      return result.hash;
    } else {
      throw new Error(`Failed to resolve round: ${result.status}`);
    }
  }

  async getActiveRound(): Promise<any | null> {
    try {
      const contract = new StellarSdk.Contract(CONTRACT_ID);
      
      const method = contract.methods.get_active_round();
      
      const result = await this.rpc.simulateTransaction(
        new StellarSdk.TransactionBuilder(new StellarSdk.Account(
          StellarSdk.Keypair.random().publicKey(),
          '0'
        ), {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: NETWORK_PASSPHRASE,
        })
        .addOperation(method)
        .setTimeout(30)
        .build()
      );

      if (!result.result) {
        return null;
      }

      return result.result;
    } catch (error) {
      console.error('Error fetching active round:', error);
      return null;
    }
  }

  async getUserPosition(userAddress: string): Promise<any | null> {
    try {
      const contract = new StellarSdk.Contract(CONTRACT_ID);
      
      const method = contract.methods.get_user_position({
        user: StellarSdk.Address.fromString(userAddress)
      });
      
      const result = await this.rpc.simulateTransaction(
        new StellarSdk.TransactionBuilder(new StellarSdk.Account(
          StellarSdk.Keypair.random().publicKey(),
          '0'
        ), {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: NETWORK_PASSPHRASE,
        })
        .addOperation(method)
        .setTimeout(30)
        .build()
      );

      if (!result.result) {
        return null;
      }

      return result.result;
    } catch (error) {
      console.error('Error fetching user position:', error);
      return null;
    }
  }

  async getBalance(userAddress: string): Promise<bigint> {
    try {
      const contract = new StellarSdk.Contract(CONTRACT_ID);
      
      const method = contract.methods.balance({
        user: StellarSdk.Address.fromString(userAddress)
      });
      
      const result = await this.rpc.simulateTransaction(
        new StellarSdk.TransactionBuilder(new StellarSdk.Account(
          StellarSdk.Keypair.random().publicKey(),
          '0'
        ), {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: NETWORK_PASSPHRASE,
        })
        .addOperation(method)
        .setTimeout(30)
        .build()
      );

      if (!result.result) {
        return 0n;
      }

      return result.result as bigint;
    } catch (error) {
      console.error('Error fetching balance:', error);
      return 0n;
    }
  }

  private async waitUntilReady(txHash: string): Promise<void> {
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      try {
        const result = await this.rpc.getTransaction(txHash);
        
        if (result.status === 'SUCCESS') {
          return;
        }

        if (result.status === 'FAILED') {
          throw new Error(`Transaction failed: ${result.resultXdr}`);
        }
      } catch (error) {
        if (attempts === maxAttempts - 1) {
          throw error;
        }
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }

    throw new Error(`Transaction not ready after ${maxAttempts} seconds`);
  }
}

const SorobanApi = {
  isTransactionError: (sim: any): boolean => {
    return sim.status !== 'SUCCESS' && sim.error !== undefined;
  }
};

export default new SorobanService();
