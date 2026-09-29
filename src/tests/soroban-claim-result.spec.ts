import { describe, it, expect } from "@jest/globals";
import {
  parseClaimResult,
} from "../services/soroban.service";
import { ExternalServiceError } from "../utils/errors";

function fixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    result: BigInt(70_000_000),
    sendTransactionResponse: { hash: "claim_tx_hash_xyz789" },
    ...overrides,
  };
}

describe("parseClaimResult", () => {
  it("parses a well-shaped claim_winnings result", () => {
    const parsed = parseClaimResult(fixture());

    expect(parsed).toEqual({
      state: "on-chain-success",
      amount: 7,
      txHash: "claim_tx_hash_xyz789",
      claimedAmount: BigInt(70_000_000),
    });
  });

  it("handles a zero-amount claim", () => {
    const parsed = parseClaimResult(fixture({ result: BigInt(0) }));

    expect(parsed.amount).toBe(0);
    expect(parsed.state).toBe("on-chain-success");
  });

  it("rejects a response without a transaction hash", () => {
    expect(() => parseClaimResult(fixture({ sendTransactionResponse: undefined }))).toThrow(
      ExternalServiceError,
    );
  });

  it("rejects a non-bigint result", () => {
    expect(() =>
      parseClaimResult(fixture({ result: "70000000" })),
    ).toThrow(ExternalServiceError);
  });

  it("rejects a negative claimed amount", () => {
    expect(() =>
      parseClaimResult(fixture({ result: BigInt(-1) })),
    ).toThrow(ExternalServiceError);
  });
});
