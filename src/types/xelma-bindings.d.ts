/**
 * Type declarations for @tevalabs/xelma-bindings
 * This is a stub for when the actual package is not available
 */

declare module '@tevalabs/xelma-bindings' {
  export interface BetSide {
    tag: 'Up' | 'Down';
    values: undefined;
  }

  export interface ClientOptions {
    contractId: string;
    networkPassphrase: string;
    rpcUrl: string;
  }

  export interface CreateRoundParams {
    start_price: bigint;
    duration_ledgers: number;
  }

  export interface PlaceBetParams {
    user: string;
    amount: bigint;
    side: BetSide;
  }

  export interface ResolveRoundParams {
    final_price: bigint;
  }

  export interface MintInitialParams {
    user: string;
  }

  export interface BalanceParams {
    user: string;
  }

  export class Client {
    constructor(options: ClientOptions);
    create_round(params: CreateRoundParams): Promise<bigint>;
    place_bet(params: PlaceBetParams): Promise<void>;
    resolve_round(params: ResolveRoundParams): Promise<void>;
    get_active_round(): Promise<any>;
    mint_initial(params: MintInitialParams): Promise<bigint>;
    balance(params: BalanceParams): Promise<bigint>;
// Type stub for @tevalabs/xelma-bindings
declare module "@tevalabs/xelma-bindings" {
  export interface BetSide {
    tag: "Up" | "Down";
    values?: any;
  }

  export interface Client {
    create_round(params: {
      start_price: BigInt;
      duration_ledgers: number;
    }): Promise<string>;

    place_bet(params: {
      user: string;
      amount: BigInt;
      side: BetSide;
    }): Promise<void>;

    resolve_round(params: { final_price: BigInt }): Promise<void>;

    get_active_round(): Promise<any>;

    mint_initial(params: { user: string }): Promise<BigInt>;

    balance(params: { user: string }): Promise<BigInt>;
  }

  export class Client {
    constructor(config: {
      contractId: string;
      networkPassphrase: string;
      rpcUrl: string;
    });
  }
}
