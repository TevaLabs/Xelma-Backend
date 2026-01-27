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
