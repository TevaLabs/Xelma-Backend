import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}





export interface Round {
  bet_end_ledger: u32;
  end_ledger: u32;
  mode: RoundMode;
  pool_down: i128;
  pool_up: i128;
  price_start: u128;
  round_id: u64;
  start_ledger: u32;
}

/**
 * Represents which side a user bet on
 */
export type BetSide = {tag: "Up", values: void} | {tag: "Down", values: void};

/**
 * Storage keys for contract data
 */
export type DataKey = {tag: "Balance", values: readonly [string]} | {tag: "Admin", values: void} | {tag: "Oracle", values: void} | {tag: "ActiveRound", values: void} | {tag: "Positions", values: void} | {tag: "UpDownPositions", values: void} | {tag: "PrecisionPositions", values: void} | {tag: "PendingWinnings", values: readonly [string]} | {tag: "UserStats", values: readonly [string]} | {tag: "BetWindowLedgers", values: void} | {tag: "RunWindowLedgers", values: void} | {tag: "LastRoundId", values: void};

/**
 * Round mode for prediction type
 */
export enum RoundMode {
  UpDown = 0,
  Precision = 1,
}


export interface UserStats {
  best_streak: u32;
  current_streak: u32;
  total_losses: u32;
  total_wins: u32;
}


export interface UserPosition {
  amount: i128;
  side: BetSide;
}


export interface OraclePayload {
  price: u128;
  /**
 * Round identifier that should match `Round.start_ledger`
 */
round_id: u32;
  timestamp: u64;
}


/**
 * Precision prediction entry (user address + predicted price)
 */
export interface PrecisionPrediction {
  amount: i128;
  predicted_price: u128;
  user: string;
}

/**
 * Contract error types
 */
export const ContractError = {
  /**
   * Contract has already been initialized
   */
  1: {message:"AlreadyInitialized"},
  /**
   * Admin address not set - call initialize first
   */
  2: {message:"AdminNotSet"},
  /**
   * Oracle address not set - call initialize first
   */
  3: {message:"OracleNotSet"},
  /**
   * Only admin can perform this action
   */
  4: {message:"UnauthorizedAdmin"},
  /**
   * Only oracle can perform this action
   */
  5: {message:"UnauthorizedOracle"},
  /**
   * Bet amount must be greater than zero
   */
  6: {message:"InvalidBetAmount"},
  /**
   * No active round exists
   */
  7: {message:"NoActiveRound"},
  /**
   * Round has already ended
   */
  8: {message:"RoundEnded"},
  /**
   * User has insufficient balance
   */
  9: {message:"InsufficientBalance"},
  /**
   * User has already placed a bet in this round
   */
  10: {message:"AlreadyBet"},
  /**
   * Arithmetic overflow occurred
   */
  11: {message:"Overflow"},
  /**
   * Invalid price value
   */
  12: {message:"InvalidPrice"},
  /**
   * Invalid duration value
   */
  13: {message:"InvalidDuration"},
  /**
   * Invalid round mode (must be 0 or 1)
   */
  14: {message:"InvalidMode"},
  /**
   * Wrong prediction type for current round mode
   */
  15: {message:"WrongModeForPrediction"},
  /**
   * Round has not reached end_ledger yet
   */
  16: {message:"RoundNotEnded"},
  /**
   * Invalid price scale (must represent 4 decimal places)
   */
  17: {message:"InvalidPriceScale"},
  /**
   * Oracle data is too old (STALE)
   */
  18: {message:"StaleOracleData"},
  /**
   * Oracle payload round_id doesn't match ActiveRound
   */
  19: {message:"InvalidOracleRound"},
  /**
   * An active round already exists and cannot be overwritten
   */
  20: {message:"RoundAlreadyActive"}
}

export interface Client {
  /**
   * Construct and simulate a balance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns user's vXLM balance
   */
  balance: ({user}: {user: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a get_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a place_bet transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Places a bet on the active round (Up/Down mode only)
   */
  place_bet: ({user, amount, side}: {user: string, amount: i128, side: BetSide}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_oracle transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_oracle: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a initialize transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Initializes the contract with admin and oracle addresses (one-time only)
   */
  initialize: ({admin, oracle}: {admin: string, oracle: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_windows transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the betting and execution windows (admin only)
   * bet_ledgers: Number of ledgers users can place bets
   * run_ledgers: Total number of ledgers before round can be resolved
   */
  set_windows: ({bet_ledgers, run_ledgers}: {bet_ledgers: u32, run_ledgers: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a create_round transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates a new prediction round (admin only)
   * mode: 0 = Up/Down (default), 1 = Precision (Legends)
   */
  create_round: ({start_price, mode}: {start_price: u128, mode: Option<u32>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a mint_initial transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Mints 1000 vXLM for new users (one-time only)
   */
  mint_initial: ({user}: {user: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a predict_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Alias for place_precision_prediction - allows users to submit exact price predictions
   * guessed_price: price scaled to 4 decimals (e.g., 0.2297 → 2297)
   */
  predict_price: ({user, guessed_price, amount}: {user: string, guessed_price: u128, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a resolve_round transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Resolves the round with oracle payload (oracle only)
   * Mode 0 (Up/Down): Winners split losers' pool proportionally; ties get refunds
   * Mode 1 (Precision/Legends): Closest guess wins full pot; ties split evenly
   */
  resolve_round: ({payload}: {payload: OraclePayload}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a claim_winnings transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Claims pending winnings and adds to balance
   */
  claim_winnings: ({user}: {user: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a get_user_stats transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns user statistics (wins, losses, streaks)
   */
  get_user_stats: ({user}: {user: string}, options?: MethodOptions) => Promise<AssembledTransaction<UserStats>>

  /**
   * Construct and simulate a get_active_round transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the currently active round, if any
   */
  get_active_round: (options?: MethodOptions) => Promise<AssembledTransaction<Option<Round>>>

  /**
   * Construct and simulate a get_last_round_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the ID of the last created round (0 if no rounds created yet)
   */
  get_last_round_id: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a get_user_position transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns user's position in the current round (Up/Down mode)
   */
  get_user_position: ({user}: {user: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<UserPosition>>>

  /**
   * Construct and simulate a get_pending_winnings transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns user's claimable winnings
   */
  get_pending_winnings: ({user}: {user: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a get_updown_positions transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns all Up/Down positions for the current round
   */
  get_updown_positions: (options?: MethodOptions) => Promise<AssembledTransaction<Map<string, UserPosition>>>

  /**
   * Construct and simulate a get_precision_predictions transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns all precision predictions for the current round
   */
  get_precision_predictions: (options?: MethodOptions) => Promise<AssembledTransaction<Array<PrecisionPrediction>>>

  /**
   * Construct and simulate a place_precision_prediction transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Places a precision prediction on the active round (Precision/Legends mode only)
   * predicted_price: price scaled to 4 decimals (e.g., 0.2297 → 2297)
   */
  place_precision_prediction: ({user, amount, predicted_price}: {user: string, amount: i128, predicted_price: u128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_user_precision_prediction transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns user's precision prediction in the current round (Precision mode)
   */
  get_user_precision_prediction: ({user}: {user: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<PrecisionPrediction>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAQAAAAAAAAAAAAAABVJvdW5kAAAAAAAACAAAAAAAAAAOYmV0X2VuZF9sZWRnZXIAAAAAAAQAAAAAAAAACmVuZF9sZWRnZXIAAAAAAAQAAAAAAAAABG1vZGUAAAfQAAAACVJvdW5kTW9kZQAAAAAAAAAAAAAJcG9vbF9kb3duAAAAAAAACwAAAAAAAAAHcG9vbF91cAAAAAALAAAAAAAAAAtwcmljZV9zdGFydAAAAAAKAAAAAAAAAAhyb3VuZF9pZAAAAAYAAAAAAAAADHN0YXJ0X2xlZGdlcgAAAAQ=",
        "AAAAAgAAACNSZXByZXNlbnRzIHdoaWNoIHNpZGUgYSB1c2VyIGJldCBvbgAAAAAAAAAAB0JldFNpZGUAAAAAAgAAAAAAAAAAAAAAAlVwAAAAAAAAAAAAAAAAAAREb3du",
        "AAAAAgAAAB5TdG9yYWdlIGtleXMgZm9yIGNvbnRyYWN0IGRhdGEAAAAAAAAAAAAHRGF0YUtleQAAAAAMAAAAAQAAAAAAAAAHQmFsYW5jZQAAAAABAAAAEwAAAAAAAAAAAAAABUFkbWluAAAAAAAAAAAAAAAAAAAGT3JhY2xlAAAAAAAAAAAAAAAAAAtBY3RpdmVSb3VuZAAAAAAAAAAAAAAAAAlQb3NpdGlvbnMAAAAAAAAAAAAAAAAAAA9VcERvd25Qb3NpdGlvbnMAAAAAAAAAAAAAAAASUHJlY2lzaW9uUG9zaXRpb25zAAAAAAABAAAAAAAAAA9QZW5kaW5nV2lubmluZ3MAAAAAAQAAABMAAAABAAAAAAAAAAlVc2VyU3RhdHMAAAAAAAABAAAAEwAAAAAAAAAAAAAAEEJldFdpbmRvd0xlZGdlcnMAAAAAAAAAAAAAABBSdW5XaW5kb3dMZWRnZXJzAAAAAAAAAAAAAAALTGFzdFJvdW5kSWQA",
        "AAAAAwAAAB5Sb3VuZCBtb2RlIGZvciBwcmVkaWN0aW9uIHR5cGUAAAAAAAAAAAAJUm91bmRNb2RlAAAAAAAAAgAAAAAAAAAGVXBEb3duAAAAAAAAAAAAAAAAAAlQcmVjaXNpb24AAAAAAAAB",
        "AAAAAQAAAAAAAAAAAAAACVVzZXJTdGF0cwAAAAAAAAQAAAAAAAAAC2Jlc3Rfc3RyZWFrAAAAAAQAAAAAAAAADmN1cnJlbnRfc3RyZWFrAAAAAAAEAAAAAAAAAAx0b3RhbF9sb3NzZXMAAAAEAAAAAAAAAAp0b3RhbF93aW5zAAAAAAAE",
        "AAAAAQAAAAAAAAAAAAAADFVzZXJQb3NpdGlvbgAAAAIAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAEc2lkZQAAB9AAAAAHQmV0U2lkZQA=",
        "AAAAAQAAAAAAAAAAAAAADU9yYWNsZVBheWxvYWQAAAAAAAADAAAAAAAAAAVwcmljZQAAAAAAAAoAAAA3Um91bmQgaWRlbnRpZmllciB0aGF0IHNob3VsZCBtYXRjaCBgUm91bmQuc3RhcnRfbGVkZ2VyYAAAAAAIcm91bmRfaWQAAAAEAAAAAAAAAAl0aW1lc3RhbXAAAAAAAAAG",
        "AAAAAQAAADtQcmVjaXNpb24gcHJlZGljdGlvbiBlbnRyeSAodXNlciBhZGRyZXNzICsgcHJlZGljdGVkIHByaWNlKQAAAAAAAAAAE1ByZWNpc2lvblByZWRpY3Rpb24AAAAAAwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAA9wcmVkaWN0ZWRfcHJpY2UAAAAACgAAAAAAAAAEdXNlcgAAABM=",
        "AAAABAAAABRDb250cmFjdCBlcnJvciB0eXBlcwAAAAAAAAANQ29udHJhY3RFcnJvcgAAAAAAABQAAAAlQ29udHJhY3QgaGFzIGFscmVhZHkgYmVlbiBpbml0aWFsaXplZAAAAAAAABJBbHJlYWR5SW5pdGlhbGl6ZWQAAAAAAAEAAAAtQWRtaW4gYWRkcmVzcyBub3Qgc2V0IC0gY2FsbCBpbml0aWFsaXplIGZpcnN0AAAAAAAAC0FkbWluTm90U2V0AAAAAAIAAAAuT3JhY2xlIGFkZHJlc3Mgbm90IHNldCAtIGNhbGwgaW5pdGlhbGl6ZSBmaXJzdAAAAAAADE9yYWNsZU5vdFNldAAAAAMAAAAiT25seSBhZG1pbiBjYW4gcGVyZm9ybSB0aGlzIGFjdGlvbgAAAAAAEVVuYXV0aG9yaXplZEFkbWluAAAAAAAABAAAACNPbmx5IG9yYWNsZSBjYW4gcGVyZm9ybSB0aGlzIGFjdGlvbgAAAAASVW5hdXRob3JpemVkT3JhY2xlAAAAAAAFAAAAJEJldCBhbW91bnQgbXVzdCBiZSBncmVhdGVyIHRoYW4gemVybwAAABBJbnZhbGlkQmV0QW1vdW50AAAABgAAABZObyBhY3RpdmUgcm91bmQgZXhpc3RzAAAAAAANTm9BY3RpdmVSb3VuZAAAAAAAAAcAAAAXUm91bmQgaGFzIGFscmVhZHkgZW5kZWQAAAAAClJvdW5kRW5kZWQAAAAAAAgAAAAdVXNlciBoYXMgaW5zdWZmaWNpZW50IGJhbGFuY2UAAAAAAAATSW5zdWZmaWNpZW50QmFsYW5jZQAAAAAJAAAAK1VzZXIgaGFzIGFscmVhZHkgcGxhY2VkIGEgYmV0IGluIHRoaXMgcm91bmQAAAAACkFscmVhZHlCZXQAAAAAAAoAAAAcQXJpdGhtZXRpYyBvdmVyZmxvdyBvY2N1cnJlZAAAAAhPdmVyZmxvdwAAAAsAAAATSW52YWxpZCBwcmljZSB2YWx1ZQAAAAAMSW52YWxpZFByaWNlAAAADAAAABZJbnZhbGlkIGR1cmF0aW9uIHZhbHVlAAAAAAAPSW52YWxpZER1cmF0aW9uAAAAAA0AAAAjSW52YWxpZCByb3VuZCBtb2RlIChtdXN0IGJlIDAgb3IgMSkAAAAAC0ludmFsaWRNb2RlAAAAAA4AAAAsV3JvbmcgcHJlZGljdGlvbiB0eXBlIGZvciBjdXJyZW50IHJvdW5kIG1vZGUAAAAWV3JvbmdNb2RlRm9yUHJlZGljdGlvbgAAAAAADwAAACRSb3VuZCBoYXMgbm90IHJlYWNoZWQgZW5kX2xlZGdlciB5ZXQAAAANUm91bmROb3RFbmRlZAAAAAAAABAAAAA1SW52YWxpZCBwcmljZSBzY2FsZSAobXVzdCByZXByZXNlbnQgNCBkZWNpbWFsIHBsYWNlcykAAAAAAAARSW52YWxpZFByaWNlU2NhbGUAAAAAAAARAAAAHk9yYWNsZSBkYXRhIGlzIHRvbyBvbGQgKFNUQUxFKQAAAAAAD1N0YWxlT3JhY2xlRGF0YQAAAAASAAAAMU9yYWNsZSBwYXlsb2FkIHJvdW5kX2lkIGRvZXNuJ3QgbWF0Y2ggQWN0aXZlUm91bmQAAAAAAAASSW52YWxpZE9yYWNsZVJvdW5kAAAAAAATAAAAOEFuIGFjdGl2ZSByb3VuZCBhbHJlYWR5IGV4aXN0cyBhbmQgY2Fubm90IGJlIG92ZXJ3cml0dGVuAAAAElJvdW5kQWxyZWFkeUFjdGl2ZQAAAAAAFA==",
        "AAAAAAAAABtSZXR1cm5zIHVzZXIncyB2WExNIGJhbGFuY2UAAAAAB2JhbGFuY2UAAAAAAQAAAAAAAAAEdXNlcgAAABMAAAABAAAACw==",
        "AAAAAAAAAAAAAAAJZ2V0X2FkbWluAAAAAAAAAAAAAAEAAAPoAAAAEw==",
        "AAAAAAAAADRQbGFjZXMgYSBiZXQgb24gdGhlIGFjdGl2ZSByb3VuZCAoVXAvRG93biBtb2RlIG9ubHkpAAAACXBsYWNlX2JldAAAAAAAAAMAAAAAAAAABHVzZXIAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAABHNpZGUAAAfQAAAAB0JldFNpZGUAAAAAAQAAA+kAAAPtAAAAAAAAB9AAAAANQ29udHJhY3RFcnJvcgAAAA==",
        "AAAAAAAAAAAAAAAKZ2V0X29yYWNsZQAAAAAAAAAAAAEAAAPoAAAAEw==",
        "AAAAAAAAAEhJbml0aWFsaXplcyB0aGUgY29udHJhY3Qgd2l0aCBhZG1pbiBhbmQgb3JhY2xlIGFkZHJlc3NlcyAob25lLXRpbWUgb25seSkAAAAKaW5pdGlhbGl6ZQAAAAAAAgAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAAZvcmFjbGUAAAAAABMAAAABAAAD6QAAA+0AAAAAAAAH0AAAAA1Db250cmFjdEVycm9yAAAA",
        "AAAAAAAAAKlTZXRzIHRoZSBiZXR0aW5nIGFuZCBleGVjdXRpb24gd2luZG93cyAoYWRtaW4gb25seSkKYmV0X2xlZGdlcnM6IE51bWJlciBvZiBsZWRnZXJzIHVzZXJzIGNhbiBwbGFjZSBiZXRzCnJ1bl9sZWRnZXJzOiBUb3RhbCBudW1iZXIgb2YgbGVkZ2VycyBiZWZvcmUgcm91bmQgY2FuIGJlIHJlc29sdmVkAAAAAAAAC3NldF93aW5kb3dzAAAAAAIAAAAAAAAAC2JldF9sZWRnZXJzAAAAAAQAAAAAAAAAC3J1bl9sZWRnZXJzAAAAAAQAAAABAAAD6QAAA+0AAAAAAAAH0AAAAA1Db250cmFjdEVycm9yAAAA",
        "AAAAAAAAAGBDcmVhdGVzIGEgbmV3IHByZWRpY3Rpb24gcm91bmQgKGFkbWluIG9ubHkpCm1vZGU6IDAgPSBVcC9Eb3duIChkZWZhdWx0KSwgMSA9IFByZWNpc2lvbiAoTGVnZW5kcykAAAAMY3JlYXRlX3JvdW5kAAAAAgAAAAAAAAALc3RhcnRfcHJpY2UAAAAACgAAAAAAAAAEbW9kZQAAA+gAAAAEAAAAAQAAA+kAAAPtAAAAAAAAB9AAAAANQ29udHJhY3RFcnJvcgAAAA==",
        "AAAAAAAAAC1NaW50cyAxMDAwIHZYTE0gZm9yIG5ldyB1c2VycyAob25lLXRpbWUgb25seSkAAAAAAAAMbWludF9pbml0aWFsAAAAAQAAAAAAAAAEdXNlcgAAABMAAAABAAAACw==",
        "AAAAAAAAAJdBbGlhcyBmb3IgcGxhY2VfcHJlY2lzaW9uX3ByZWRpY3Rpb24gLSBhbGxvd3MgdXNlcnMgdG8gc3VibWl0IGV4YWN0IHByaWNlIHByZWRpY3Rpb25zCmd1ZXNzZWRfcHJpY2U6IHByaWNlIHNjYWxlZCB0byA0IGRlY2ltYWxzIChlLmcuLCAwLjIyOTcg4oaSIDIyOTcpAAAAAA1wcmVkaWN0X3ByaWNlAAAAAAAAAwAAAAAAAAAEdXNlcgAAABMAAAAAAAAADWd1ZXNzZWRfcHJpY2UAAAAAAAAKAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAA+0AAAAAAAAH0AAAAA1Db250cmFjdEVycm9yAAAA",
        "AAAAAAAAAM1SZXNvbHZlcyB0aGUgcm91bmQgd2l0aCBvcmFjbGUgcGF5bG9hZCAob3JhY2xlIG9ubHkpCk1vZGUgMCAoVXAvRG93bik6IFdpbm5lcnMgc3BsaXQgbG9zZXJzJyBwb29sIHByb3BvcnRpb25hbGx5OyB0aWVzIGdldCByZWZ1bmRzCk1vZGUgMSAoUHJlY2lzaW9uL0xlZ2VuZHMpOiBDbG9zZXN0IGd1ZXNzIHdpbnMgZnVsbCBwb3Q7IHRpZXMgc3BsaXQgZXZlbmx5AAAAAAAADXJlc29sdmVfcm91bmQAAAAAAAABAAAAAAAAAAdwYXlsb2FkAAAAB9AAAAANT3JhY2xlUGF5bG9hZAAAAAAAAAEAAAPpAAAD7QAAAAAAAAfQAAAADUNvbnRyYWN0RXJyb3IAAAA=",
        "AAAAAAAAACtDbGFpbXMgcGVuZGluZyB3aW5uaW5ncyBhbmQgYWRkcyB0byBiYWxhbmNlAAAAAA5jbGFpbV93aW5uaW5ncwAAAAAAAQAAAAAAAAAEdXNlcgAAABMAAAABAAAACw==",
        "AAAAAAAAAC9SZXR1cm5zIHVzZXIgc3RhdGlzdGljcyAod2lucywgbG9zc2VzLCBzdHJlYWtzKQAAAAAOZ2V0X3VzZXJfc3RhdHMAAAAAAAEAAAAAAAAABHVzZXIAAAATAAAAAQAAB9AAAAAJVXNlclN0YXRzAAAA",
        "AAAAAAAAACpSZXR1cm5zIHRoZSBjdXJyZW50bHkgYWN0aXZlIHJvdW5kLCBpZiBhbnkAAAAAABBnZXRfYWN0aXZlX3JvdW5kAAAAAAAAAAEAAAPoAAAH0AAAAAVSb3VuZAAAAA==",
        "AAAAAAAAAEVSZXR1cm5zIHRoZSBJRCBvZiB0aGUgbGFzdCBjcmVhdGVkIHJvdW5kICgwIGlmIG5vIHJvdW5kcyBjcmVhdGVkIHlldCkAAAAAAAARZ2V0X2xhc3Rfcm91bmRfaWQAAAAAAAAAAAAAAQAAAAY=",
        "AAAAAAAAADtSZXR1cm5zIHVzZXIncyBwb3NpdGlvbiBpbiB0aGUgY3VycmVudCByb3VuZCAoVXAvRG93biBtb2RlKQAAAAARZ2V0X3VzZXJfcG9zaXRpb24AAAAAAAABAAAAAAAAAAR1c2VyAAAAEwAAAAEAAAPoAAAH0AAAAAxVc2VyUG9zaXRpb24=",
        "AAAAAAAAACFSZXR1cm5zIHVzZXIncyBjbGFpbWFibGUgd2lubmluZ3MAAAAAAAAUZ2V0X3BlbmRpbmdfd2lubmluZ3MAAAABAAAAAAAAAAR1c2VyAAAAEwAAAAEAAAAL",
        "AAAAAAAAADNSZXR1cm5zIGFsbCBVcC9Eb3duIHBvc2l0aW9ucyBmb3IgdGhlIGN1cnJlbnQgcm91bmQAAAAAFGdldF91cGRvd25fcG9zaXRpb25zAAAAAAAAAAEAAAPsAAAAEwAAB9AAAAAMVXNlclBvc2l0aW9u",
        "AAAAAAAAADdSZXR1cm5zIGFsbCBwcmVjaXNpb24gcHJlZGljdGlvbnMgZm9yIHRoZSBjdXJyZW50IHJvdW5kAAAAABlnZXRfcHJlY2lzaW9uX3ByZWRpY3Rpb25zAAAAAAAAAAAAAAEAAAPqAAAH0AAAABNQcmVjaXNpb25QcmVkaWN0aW9uAA==",
        "AAAAAAAAAJNQbGFjZXMgYSBwcmVjaXNpb24gcHJlZGljdGlvbiBvbiB0aGUgYWN0aXZlIHJvdW5kIChQcmVjaXNpb24vTGVnZW5kcyBtb2RlIG9ubHkpCnByZWRpY3RlZF9wcmljZTogcHJpY2Ugc2NhbGVkIHRvIDQgZGVjaW1hbHMgKGUuZy4sIDAuMjI5NyDihpIgMjI5NykAAAAAGnBsYWNlX3ByZWNpc2lvbl9wcmVkaWN0aW9uAAAAAAADAAAAAAAAAAR1c2VyAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAA9wcmVkaWN0ZWRfcHJpY2UAAAAACgAAAAEAAAPpAAAD7QAAAAAAAAfQAAAADUNvbnRyYWN0RXJyb3IAAAA=",
        "AAAAAAAAAElSZXR1cm5zIHVzZXIncyBwcmVjaXNpb24gcHJlZGljdGlvbiBpbiB0aGUgY3VycmVudCByb3VuZCAoUHJlY2lzaW9uIG1vZGUpAAAAAAAAHWdldF91c2VyX3ByZWNpc2lvbl9wcmVkaWN0aW9uAAAAAAAAAQAAAAAAAAAEdXNlcgAAABMAAAABAAAD6AAAB9AAAAATUHJlY2lzaW9uUHJlZGljdGlvbgA=" ]),
      options
    )
  }
  public readonly fromJSON = {
    balance: this.txFromJSON<i128>,
        get_admin: this.txFromJSON<Option<string>>,
        place_bet: this.txFromJSON<Result<void>>,
        get_oracle: this.txFromJSON<Option<string>>,
        initialize: this.txFromJSON<Result<void>>,
        set_windows: this.txFromJSON<Result<void>>,
        create_round: this.txFromJSON<Result<void>>,
        mint_initial: this.txFromJSON<i128>,
        predict_price: this.txFromJSON<Result<void>>,
        resolve_round: this.txFromJSON<Result<void>>,
        claim_winnings: this.txFromJSON<i128>,
        get_user_stats: this.txFromJSON<UserStats>,
        get_active_round: this.txFromJSON<Option<Round>>,
        get_last_round_id: this.txFromJSON<u64>,
        get_user_position: this.txFromJSON<Option<UserPosition>>,
        get_pending_winnings: this.txFromJSON<i128>,
        get_updown_positions: this.txFromJSON<Map<string, UserPosition>>,
        get_precision_predictions: this.txFromJSON<Array<PrecisionPrediction>>,
        place_precision_prediction: this.txFromJSON<Result<void>>,
        get_user_precision_prediction: this.txFromJSON<Option<PrecisionPrediction>>
  }
}