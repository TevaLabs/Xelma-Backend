import { describe, it, expect } from "@jest/globals";
import {
  parseClaimResult,
  InvalidClaimResultError,
} from "../services/soroban.service";
import type { contract } from "@tevalabs/xelma-bindings";

function fixture(
  overrides: Partial<contract.SentTransaction<bigint>> = {},
): contract.SentTransaction<bigint> {
  return {
    result: BigInt(70_000_000),
    sendTransactionResponse: { hash: "claim_tx_hash_xyz789" } as any,
    ...overrides,
  } as contract.SentTransaction<bigint>;
}

describe("parseClaimResult", () => {
  it("parses a well-shaped claim_winnings result", () => {
    const parsed = parseClaimResult(fixture());

    expect(parsed).toEqual({
      state: "on-chain-success",
      amount: 7,
      txHash: "claim_tx_hash_xyz789",
    });
  });

  it("handles a zero-amount claim", () => {
    const parsed = parseClaimResult(fixture({ result: BigInt(0) }));

    expect(parsed.amount).toBe(0);
    expect(parsed.state).toBe("on-chain-success");
  });

  it("omits txHash when sendTransactionResponse is absent", () => {
    const parsed = parseClaimResult(
      fixture({ sendTransactionResponse: undefined }),
    );

    expect(parsed.txHash).toBeUndefined();
  });

  it("rejects a non-bigint result", () => {
    expect(() =>
      parseClaimResult(fixture({ result: "70000000" as unknown as bigint })),
    ).toThrow(InvalidClaimResultError);
  });

  it("rejects a negative claimed amount", () => {
    expect(() =>
      parseClaimResult(fixture({ result: BigInt(-1) })),
    ).toThrow(InvalidClaimResultError);
  });
});
