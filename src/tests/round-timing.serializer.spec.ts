import { describe, expect, it, jest } from "@jest/globals";
import { serializeRound } from "../serializers/monetary.serializer";

describe("serializeRound timing fields", () => {
  it("exposes server-computed timer fields and clamps elapsed rounds", () => {
    jest.spyOn(Date, "now").mockReturnValue(new Date("2026-09-27T12:00:00.000Z").getTime());

    expect(
      serializeRound({
        id: "round-1",
        endTime: new Date("2026-09-27T12:00:30.000Z"),
        resolvedAt: null,
      }),
    ).toEqual(
      expect.objectContaining({
        bettingClosesAt: "2026-09-27T12:00:30.000Z",
        lockAt: "2026-09-27T12:00:30.000Z",
        resolveAt: null,
        secondsRemaining: 30,
      }),
    );

    jest.spyOn(Date, "now").mockReturnValue(new Date("2026-09-27T12:01:00.000Z").getTime());
    expect(
      serializeRound({ endTime: new Date("2026-09-27T12:00:30.000Z") }),
    ).toEqual(expect.objectContaining({ secondsRemaining: 0 }));

    jest.restoreAllMocks();
  });
});
