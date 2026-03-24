import { Buffer } from "buffer";
import { Client as ContractClient, Spec as ContractSpec, } from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";
if (typeof window !== "undefined") {
    //@ts-ignore Buffer exists
    window.Buffer = window.Buffer || Buffer;
}
/**
 * Round mode for prediction type
 */
export var RoundMode;
(function (RoundMode) {
    RoundMode[RoundMode["UpDown"] = 0] = "UpDown";
    RoundMode[RoundMode["Precision"] = 1] = "Precision";
})(RoundMode || (RoundMode = {}));
/**
 * Contract error types
 */
export const ContractError = {
    /**
     * Contract has already been initialized
     */
    1: { message: "AlreadyInitialized" },
    /**
     * Admin address not set - call initialize first
     */
    2: { message: "AdminNotSet" },
    /**
     * Oracle address not set - call initialize first
     */
    3: { message: "OracleNotSet" },
    /**
     * Only admin can perform this action
     */
    4: { message: "UnauthorizedAdmin" },
    /**
     * Only oracle can perform this action
     */
    5: { message: "UnauthorizedOracle" },
    /**
     * Bet amount must be greater than zero
     */
    6: { message: "InvalidBetAmount" },
    /**
     * No active round exists
     */
    7: { message: "NoActiveRound" },
    /**
     * Round has already ended
     */
    8: { message: "RoundEnded" },
    /**
     * User has insufficient balance
     */
    9: { message: "InsufficientBalance" },
    /**
     * User has already placed a bet in this round
     */
    10: { message: "AlreadyBet" },
    /**
     * Arithmetic overflow occurred
     */
    11: { message: "Overflow" },
    /**
     * Invalid price value
     */
    12: { message: "InvalidPrice" },
    /**
     * Invalid duration value
     */
    13: { message: "InvalidDuration" },
    /**
     * Invalid round mode (must be 0 or 1)
     */
    14: { message: "InvalidMode" },
    /**
     * Wrong prediction type for current round mode
     */
    15: { message: "WrongModeForPrediction" },
    /**
     * Round has not reached end_ledger yet
     */
    16: { message: "RoundNotEnded" },
    /**
     * Invalid price scale (must represent 4 decimal places)
     */
    17: { message: "InvalidPriceScale" },
    /**
     * Oracle data is too old (STALE)
     */
    18: { message: "StaleOracleData" },
    /**
     * Oracle payload round_id doesn't match ActiveRound
     */
    19: { message: "InvalidOracleRound" },
    /**
     * An active round already exists and cannot be overwritten
     */
    20: { message: "RoundAlreadyActive" }
};
export class Client extends ContractClient {
    options;
    static async deploy(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options) {
        return ContractClient.deploy(null, options);
    }
    constructor(options) {
        super(new ContractSpec(["AAAAAQAAAAAAAAAAAAAABVJvdW5kAAAAAAAACAAAAAAAAAAOYmV0X2VuZF9sZWRnZXIAAAAAAAQAAAAAAAAACmVuZF9sZWRnZXIAAAAAAAQAAAAAAAAABG1vZGUAAAfQAAAACVJvdW5kTW9kZQAAAAAAAAAAAAAJcG9vbF9kb3duAAAAAAAACwAAAAAAAAAHcG9vbF91cAAAAAALAAAAAAAAAAtwcmljZV9zdGFydAAAAAAKAAAAAAAAAAhyb3VuZF9pZAAAAAYAAAAAAAAADHN0YXJ0X2xlZGdlcgAAAAQ=",
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
            "AAAAAAAAAElSZXR1cm5zIHVzZXIncyBwcmVjaXNpb24gcHJlZGljdGlvbiBpbiB0aGUgY3VycmVudCByb3VuZCAoUHJlY2lzaW9uIG1vZGUpAAAAAAAAHWdldF91c2VyX3ByZWNpc2lvbl9wcmVkaWN0aW9uAAAAAAAAAQAAAAAAAAAEdXNlcgAAABMAAAABAAAD6AAAB9AAAAATUHJlY2lzaW9uUHJlZGljdGlvbgA="]), options);
        this.options = options;
    }
    fromJSON = {
        balance: (this.txFromJSON),
        get_admin: (this.txFromJSON),
        place_bet: (this.txFromJSON),
        get_oracle: (this.txFromJSON),
        initialize: (this.txFromJSON),
        set_windows: (this.txFromJSON),
        create_round: (this.txFromJSON),
        mint_initial: (this.txFromJSON),
        predict_price: (this.txFromJSON),
        resolve_round: (this.txFromJSON),
        claim_winnings: (this.txFromJSON),
        get_user_stats: (this.txFromJSON),
        get_active_round: (this.txFromJSON),
        get_last_round_id: (this.txFromJSON),
        get_user_position: (this.txFromJSON),
        get_pending_winnings: (this.txFromJSON),
        get_updown_positions: (this.txFromJSON),
        get_precision_predictions: (this.txFromJSON),
        place_precision_prediction: (this.txFromJSON),
        get_user_precision_prediction: (this.txFromJSON)
    };
}
