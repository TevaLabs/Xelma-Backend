import { describe, it, expect } from "@jest/globals";
import { RoundMode } from "@tevalabs/xelma-bindings";
import { mapSorobanActiveRound } from "../utils/soroban-round.mapper";

describe("mapSorobanActiveRound", () => {
  it("maps UP/DOWN round fields to API shape", () => {
    const mapped = mapSorobanActiveRound({
      round_id: BigInt(42),
      mode: RoundMode.UpDown,
      price_start: BigInt(12345),
      pool_up: BigInt(50_000_000),
      pool_down: BigInt(25_000_000),
      start_ledger: 1000,
      bet_end_ledger: 1100,
      end_ledger: 1200,
    });

    expect(mapped).toEqual({
      id: "soroban-42",
      sorobanRoundId: "42",
      mode: "UP_DOWN",
      status: "ACTIVE",
      startPrice: 1.2345,
      poolUp: 5,
      poolDown: 2.5,
      startLedger: 1000,
      betEndLedger: 1100,
      endLedger: 1200,
      isSoroban: true,
      source: "soroban",
    });
  });

  it("maps Precision mode to LEGENDS", () => {
    const mapped = mapSorobanActiveRound({
      round_id: 7,
      mode: RoundMode.Precision,
      price_start: 10000,
      pool_up: 0,
      pool_down: 0,
      start_ledger: 1,
      bet_end_ledger: 2,
      end_ledger: 3,
    });

    expect(mapped.mode).toBe("LEGENDS");
    expect(mapped.startPrice).toBe(1);
  });
});
