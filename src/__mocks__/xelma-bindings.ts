/**
 * Jest mock for @tevalabs/xelma-bindings (ESM package that Jest does not transform).
 * Used by specs that import createApp (auth, socket, notifications) to avoid loading the real package.
 */
export const BetSide = { Up: { tag: "Up" as const, values: undefined }, Down: { tag: "Down" as const, values: undefined } };

export class Client {
  constructor(_opts: any) {}
  async create_round(_params: any): Promise<bigint> {
    return BigInt(0);
  }
  async place_bet(_params: any): Promise<void> {}
  async resolve_round(_params: any): Promise<void> {}
  async get_active_round(): Promise<any> {
    return null;
  }
  async mint_initial(_params: any): Promise<bigint> {
    return BigInt(0);
  }
  async balance(_params: any): Promise<bigint> {
    return BigInt(0);
  }
}
