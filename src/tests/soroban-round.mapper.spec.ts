import { describe, it, expect } from "@jest/globals";
import { RoundMode } from "@tevalabs/xelma-bindings";
import {
  mapSorobanActiveRound,
  mapSorobanRoundToFrontendCards,
  resolveRoundMode,
} from "../utils/soroban-round.mapper";

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
      startPrice: "1.23450000",
      poolUp: "5.00000000",
      poolDown: "2.50000000",
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
    expect(mapped.startPrice).toBe("1.00000000");
  });

  it("rejects an unrecognized round mode instead of silently mapping it", () => {
    expect(() =>
      mapSorobanActiveRound({
        round_id: 1,
        mode: 99 as RoundMode,
        price_start: 10000,
        pool_up: 0,
        pool_down: 0,
        start_ledger: 1,
        bet_end_ledger: 2,
        end_ledger: 3,
      }),
    ).toThrow(/Unsupported Soroban round mode/);
  });
});

describe("resolveRoundMode", () => {
  it("maps known modes", () => {
    expect(resolveRoundMode(RoundMode.UpDown)).toBe("UP_DOWN");
    expect(resolveRoundMode(RoundMode.Precision)).toBe("LEGENDS");
  });

  it("throws on an unknown mode value", () => {
    expect(() => resolveRoundMode(99 as RoundMode)).toThrow(
      /Unsupported Soroban round mode/,
    );
  });
});

describe("mapSorobanRoundToFrontendCards", () => {
  const liveRound = {
    round_id: BigInt(99),
    mode: RoundMode.UpDown,
    price_start: BigInt(1200000),
    pool_up: BigInt(20_000_000),
    pool_down: BigInt(10_000_000),
    start_ledger: 100,
    bet_end_ledger: 200,
    end_ledger: 300,
  } as any;

  it("maps a live Soroban round into a frontend card", () => {
    const cards = mapSorobanRoundToFrontendCards(liveRound);

    const liveCard = cards.find((card) => card.source === "live");

    expect(liveCard).toBeDefined();
    expect(liveCard?.asset).toBe("XLM");
    expect(liveCard?.source).toBe("live");
    expect(liveCard?.roundStatus).toBe("ACTIVE");
    expect(liveCard?.priceData.startPrice).toBe("120.00000000");
    expect(liveCard?.poolValues.upPool).toBe("2.00000000");
  });

  it("returns one live card and the rest mock cards for mixed output", () => {
    const cards = mapSorobanRoundToFrontendCards(liveRound);

    expect(cards).toHaveLength(3);
    expect(cards.filter((card) => card.source === "live")).toHaveLength(1);
    expect(cards.filter((card) => card.source === "mock")).toHaveLength(2);
    expect(cards.map((card) => card.asset)).toEqual(expect.arrayContaining(["BTC", "ETH", "XLM"]));
  });

  it("returns only mock cards when no chain data is available", () => {
    const cards = mapSorobanRoundToFrontendCards(null);

    expect(cards).toHaveLength(3);
    expect(cards.every((card) => card.source === "mock")).toBe(true);
    expect(cards.map((card) => card.asset)).toEqual(["BTC", "ETH", "XLM"]);
  });

  it("adds source metadata to every returned card", () => {
    const cards = mapSorobanRoundToFrontendCards(liveRound);

    cards.forEach((card) => {
      expect(card).toEqual(
        expect.objectContaining({
          source: expect.any(String),
          id: expect.any(String),
          asset: expect.any(String),
        })
      );
    });
  });

  it("preserves the expected frontend schema", () => {
    const cards = mapSorobanRoundToFrontendCards(liveRound);
    const card = cards[0];

    expect(card).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        asset: expect.any(String),
        mode: expect.any(String),
        status: expect.any(String),
        startPrice: expect.any(String),
        source: expect.any(String),
        roundStatus: expect.any(String),
        roundTiming: expect.objectContaining({
          startsAt: expect.any(String),
          endsAt: expect.any(String),
        }),
        priceData: expect.objectContaining({
          startPrice: expect.any(String),
          currentPrice: expect.any(String),
        }),
        poolValues: expect.any(Object),
        predictionMetadata: expect.objectContaining({
          predictionCount: expect.any(Number),
          canPredict: expect.any(Boolean),
        }),
      })
    );
  });
});
