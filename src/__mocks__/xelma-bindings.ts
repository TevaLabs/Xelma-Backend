/**
 * Jest mock for @tevalabs/xelma-bindings (ESM package that Jest does not transform).
 * Used by specs that import createApp (auth, socket, notifications) to avoid loading the real package.
 *
 * Methods return minimal AssembledTransaction-shaped objects: { result, signAndSend }.
 */

function mockTx<T>(result: T) {
  return Promise.resolve({
    result,
    signAndSend: async (_opts?: unknown) => ({ result }),
  });
}

export const BetSide = {
  Up: { tag: "Up" as const, values: undefined },
  Down: { tag: "Down" as const, values: undefined },
};

export enum RoundMode {
  UpDown = 0,
  Precision = 1,
}

export type OraclePayload = {
  final_price: bigint;
  timestamp: bigint;
};

export class Client {
  constructor(_opts: unknown) {}
  balance(_params: unknown)                { return mockTx(BigInt(0)); }
  get_admin(_opts?: unknown)               { return mockTx<string | null>(null); }
  get_oracle(_opts?: unknown)              { return mockTx<string | null>(null); }
  initialize(_params: unknown)             { return mockTx(undefined); }
  set_windows(_params: unknown)            { return mockTx(undefined); }
  create_round(_params: unknown)           { return mockTx(undefined); }
  place_bet(_params: unknown)              { return mockTx(undefined); }
  predict_price(_params: unknown)          { return mockTx(undefined); }
  resolve_round(_params: unknown)          { return mockTx(undefined); }
  claim_winnings(_params: unknown)         { return mockTx(BigInt(0)); }
  mint_initial(_params: unknown)           { return mockTx(BigInt(0)); }
  get_active_round(_opts?: unknown)        { return mockTx<null>(null); }
  get_last_round_id(_opts?: unknown)       { return mockTx(BigInt(0)); }
  get_user_stats(_params: unknown)         { return mockTx({ best_streak: 0, current_streak: 0, total_losses: 0, total_wins: 0 }); }
  get_user_position(_params: unknown)      { return mockTx<null>(null); }
  get_pending_winnings(_params: unknown)   { return mockTx(BigInt(0)); }
  get_updown_positions(_opts?: unknown)    { return mockTx(new Map()); }
  get_precision_predictions(_opts?: unknown) { return mockTx([]); }
  place_precision_prediction(_params: unknown) { return mockTx(undefined); }
  get_user_precision_prediction(_params: unknown) { return mockTx<null>(null); }
}
