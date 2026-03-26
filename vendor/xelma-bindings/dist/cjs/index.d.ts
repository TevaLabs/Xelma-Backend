import { Buffer } from "buffer";
import { AssembledTransaction, Client as ContractClient, ClientOptions as ContractClientOptions, MethodOptions, Result } from "@stellar/stellar-sdk/contract";
import type { u32, u64, u128, i128, Option } from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";
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
export type BetSide = {
    tag: "Up";
    values: void;
} | {
    tag: "Down";
    values: void;
};
/**
 * Storage keys for contract data
 */
export type DataKey = {
    tag: "Balance";
    values: readonly [string];
} | {
    tag: "Admin";
    values: void;
} | {
    tag: "Oracle";
    values: void;
} | {
    tag: "ActiveRound";
    values: void;
} | {
    tag: "Positions";
    values: void;
} | {
    tag: "UpDownPositions";
    values: void;
} | {
    tag: "PrecisionPositions";
    values: void;
} | {
    tag: "PendingWinnings";
    values: readonly [string];
} | {
    tag: "UserStats";
    values: readonly [string];
} | {
    tag: "BetWindowLedgers";
    values: void;
} | {
    tag: "RunWindowLedgers";
    values: void;
} | {
    tag: "LastRoundId";
    values: void;
};
/**
 * Round mode for prediction type
 */
export declare enum RoundMode {
    UpDown = 0,
    Precision = 1
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
export declare const ContractError: {
    /**
     * Contract has already been initialized
     */
    1: {
        message: string;
    };
    /**
     * Admin address not set - call initialize first
     */
    2: {
        message: string;
    };
    /**
     * Oracle address not set - call initialize first
     */
    3: {
        message: string;
    };
    /**
     * Only admin can perform this action
     */
    4: {
        message: string;
    };
    /**
     * Only oracle can perform this action
     */
    5: {
        message: string;
    };
    /**
     * Bet amount must be greater than zero
     */
    6: {
        message: string;
    };
    /**
     * No active round exists
     */
    7: {
        message: string;
    };
    /**
     * Round has already ended
     */
    8: {
        message: string;
    };
    /**
     * User has insufficient balance
     */
    9: {
        message: string;
    };
    /**
     * User has already placed a bet in this round
     */
    10: {
        message: string;
    };
    /**
     * Arithmetic overflow occurred
     */
    11: {
        message: string;
    };
    /**
     * Invalid price value
     */
    12: {
        message: string;
    };
    /**
     * Invalid duration value
     */
    13: {
        message: string;
    };
    /**
     * Invalid round mode (must be 0 or 1)
     */
    14: {
        message: string;
    };
    /**
     * Wrong prediction type for current round mode
     */
    15: {
        message: string;
    };
    /**
     * Round has not reached end_ledger yet
     */
    16: {
        message: string;
    };
    /**
     * Invalid price scale (must represent 4 decimal places)
     */
    17: {
        message: string;
    };
    /**
     * Oracle data is too old (STALE)
     */
    18: {
        message: string;
    };
    /**
     * Oracle payload round_id doesn't match ActiveRound
     */
    19: {
        message: string;
    };
    /**
     * An active round already exists and cannot be overwritten
     */
    20: {
        message: string;
    };
};
export interface Client {
    /**
     * Construct and simulate a balance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Returns user's vXLM balance
     */
    balance: ({ user }: {
        user: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<i128>>;
    /**
     * Construct and simulate a get_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    get_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>;
    /**
     * Construct and simulate a place_bet transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Places a bet on the active round (Up/Down mode only)
     */
    place_bet: ({ user, amount, side }: {
        user: string;
        amount: i128;
        side: BetSide;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a get_oracle transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    get_oracle: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>;
    /**
     * Construct and simulate a initialize transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Initializes the contract with admin and oracle addresses (one-time only)
     */
    initialize: ({ admin, oracle }: {
        admin: string;
        oracle: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a set_windows transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Sets the betting and execution windows (admin only)
     * bet_ledgers: Number of ledgers users can place bets
     * run_ledgers: Total number of ledgers before round can be resolved
     */
    set_windows: ({ bet_ledgers, run_ledgers }: {
        bet_ledgers: u32;
        run_ledgers: u32;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a create_round transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Creates a new prediction round (admin only)
     * mode: 0 = Up/Down (default), 1 = Precision (Legends)
     */
    create_round: ({ start_price, mode }: {
        start_price: u128;
        mode: Option<u32>;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a mint_initial transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Mints 1000 vXLM for new users (one-time only)
     */
    mint_initial: ({ user }: {
        user: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<i128>>;
    /**
     * Construct and simulate a predict_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Alias for place_precision_prediction - allows users to submit exact price predictions
     * guessed_price: price scaled to 4 decimals (e.g., 0.2297 → 2297)
     */
    predict_price: ({ user, guessed_price, amount }: {
        user: string;
        guessed_price: u128;
        amount: i128;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a resolve_round transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Resolves the round with oracle payload (oracle only)
     * Mode 0 (Up/Down): Winners split losers' pool proportionally; ties get refunds
     * Mode 1 (Precision/Legends): Closest guess wins full pot; ties split evenly
     */
    resolve_round: ({ payload }: {
        payload: OraclePayload;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a claim_winnings transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Claims pending winnings and adds to balance
     */
    claim_winnings: ({ user }: {
        user: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<i128>>;
    /**
     * Construct and simulate a get_user_stats transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Returns user statistics (wins, losses, streaks)
     */
    get_user_stats: ({ user }: {
        user: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<UserStats>>;
    /**
     * Construct and simulate a get_active_round transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Returns the currently active round, if any
     */
    get_active_round: (options?: MethodOptions) => Promise<AssembledTransaction<Option<Round>>>;
    /**
     * Construct and simulate a get_last_round_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Returns the ID of the last created round (0 if no rounds created yet)
     */
    get_last_round_id: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>;
    /**
     * Construct and simulate a get_user_position transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Returns user's position in the current round (Up/Down mode)
     */
    get_user_position: ({ user }: {
        user: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Option<UserPosition>>>;
    /**
     * Construct and simulate a get_pending_winnings transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Returns user's claimable winnings
     */
    get_pending_winnings: ({ user }: {
        user: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<i128>>;
    /**
     * Construct and simulate a get_updown_positions transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Returns all Up/Down positions for the current round
     */
    get_updown_positions: (options?: MethodOptions) => Promise<AssembledTransaction<Map<string, UserPosition>>>;
    /**
     * Construct and simulate a get_precision_predictions transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Returns all precision predictions for the current round
     */
    get_precision_predictions: (options?: MethodOptions) => Promise<AssembledTransaction<Array<PrecisionPrediction>>>;
    /**
     * Construct and simulate a place_precision_prediction transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Places a precision prediction on the active round (Precision/Legends mode only)
     * predicted_price: price scaled to 4 decimals (e.g., 0.2297 → 2297)
     */
    place_precision_prediction: ({ user, amount, predicted_price }: {
        user: string;
        amount: i128;
        predicted_price: u128;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a get_user_precision_prediction transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Returns user's precision prediction in the current round (Precision mode)
     */
    get_user_precision_prediction: ({ user }: {
        user: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Option<PrecisionPrediction>>>;
}
export declare class Client extends ContractClient {
    readonly options: ContractClientOptions;
    static deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions & Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
    }): Promise<AssembledTransaction<T>>;
    constructor(options: ContractClientOptions);
    readonly fromJSON: {
        balance: (json: string) => AssembledTransaction<bigint>;
        get_admin: (json: string) => AssembledTransaction<Option<string>>;
        place_bet: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        get_oracle: (json: string) => AssembledTransaction<Option<string>>;
        initialize: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        set_windows: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        create_round: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        mint_initial: (json: string) => AssembledTransaction<bigint>;
        predict_price: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        resolve_round: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        claim_winnings: (json: string) => AssembledTransaction<bigint>;
        get_user_stats: (json: string) => AssembledTransaction<UserStats>;
        get_active_round: (json: string) => AssembledTransaction<Option<Round>>;
        get_last_round_id: (json: string) => AssembledTransaction<bigint>;
        get_user_position: (json: string) => AssembledTransaction<Option<UserPosition>>;
        get_pending_winnings: (json: string) => AssembledTransaction<bigint>;
        get_updown_positions: (json: string) => AssembledTransaction<Map<string, UserPosition>>;
        get_precision_predictions: (json: string) => AssembledTransaction<PrecisionPrediction[]>;
        place_precision_prediction: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        get_user_precision_prediction: (json: string) => AssembledTransaction<Option<PrecisionPrediction>>;
    };
}
