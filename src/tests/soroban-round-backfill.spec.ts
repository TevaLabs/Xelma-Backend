import {
  isValidSorobanRoundId,
  parseSorobanRoundIdMapping,
  planSorobanRoundBackfill,
} from "../utils/soroban-round.mapper";

const rounds = [
  { id: "round-a", sorobanRoundId: null },
  { id: "round-b", sorobanRoundId: null },
  { id: "round-c", sorobanRoundId: "7" },
  { id: "round-d", sorobanRoundId: null },
];

describe("soroban round id backfill", () => {
  it("accepts object and array mappings", () => {
    expect(parseSorobanRoundIdMapping({ "round-a": "1" })).toEqual([
      { roundId: "round-a", sorobanRoundId: "1" },
    ]);
    expect(
      parseSorobanRoundIdMapping([{ roundId: "round-a", sorobanRoundId: 12 }]),
    ).toEqual([{ roundId: "round-a", sorobanRoundId: "12" }]);
  });

  it("rejects malformed or invalid ids", () => {
    expect(() => parseSorobanRoundIdMapping("nope")).toThrow(/JSON object/);
    expect(() => parseSorobanRoundIdMapping({ "round-a": "abc" })).toThrow(
      /Invalid sorobanRoundId/,
    );
    expect(() => parseSorobanRoundIdMapping({ "round-a": "0" })).toThrow(
      /Invalid sorobanRoundId/,
    );
    expect(() =>
      parseSorobanRoundIdMapping([
        { roundId: "round-a", sorobanRoundId: "1" },
        { roundId: "round-a", sorobanRoundId: "2" },
      ]),
    ).toThrow(/Duplicate mapping entry/);
    expect(isValidSorobanRoundId("42")).toBe(true);
    expect(isValidSorobanRoundId("-1")).toBe(false);
  });

  it("plans only unambiguous, unassigned updates", () => {
    const plan = planSorobanRoundBackfill(rounds, [
      { roundId: "round-a", sorobanRoundId: "10" },
      { roundId: "round-b", sorobanRoundId: "11" },
      { roundId: "round-c", sorobanRoundId: "7" }, // already applied
      { roundId: "round-c", sorobanRoundId: "12" }, // duplicate input row
      { roundId: "round-d", sorobanRoundId: "10" }, // id already claimed
      { roundId: "missing", sorobanRoundId: "13" },
    ]);

    expect(plan.updates).toEqual([
      { roundId: "round-a", sorobanRoundId: "10" },
      { roundId: "round-b", sorobanRoundId: "11" },
    ]);
    expect(plan.skipped).toEqual([
      { roundId: "round-c", sorobanRoundId: "7", reason: "already_applied" },
      { roundId: "round-c", sorobanRoundId: "12", reason: "already_assigned" },
      { roundId: "round-d", sorobanRoundId: "10", reason: "soroban_id_taken" },
      { roundId: "missing", sorobanRoundId: "13", reason: "unknown_round" },
    ]);
  });

  it("never reassigns an id owned by an untargeted round", () => {
    const plan = planSorobanRoundBackfill(rounds, [
      { roundId: "round-a", sorobanRoundId: "7" },
    ]);

    expect(plan.updates).toEqual([]);
    expect(plan.skipped[0].reason).toBe("soroban_id_taken");
  });

  it("is idempotent: replaying an applied plan updates nothing", () => {
    const first = planSorobanRoundBackfill(rounds, [
      { roundId: "round-a", sorobanRoundId: "10" },
    ]);
    const after = rounds.map((round) =>
      round.id === "round-a" ? { ...round, sorobanRoundId: "10" } : round,
    );

    const second = planSorobanRoundBackfill(after, first.updates.map((u) => ({
      roundId: u.roundId,
      sorobanRoundId: u.sorobanRoundId,
    })));
    expect(second.updates).toEqual([]);
    expect(second.skipped[0].reason).toBe("already_applied");
  });
});
