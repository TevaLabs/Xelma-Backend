import { upDownBetSchema, precisionBetSchema } from "../schemas/bets.schema";
import { submitPredictionSchema } from "../schemas/predictions.schema";
import { submitLegendsPredictionSchema } from "../schemas/rounds.schema";
import { DEFAULT_MAX_STAKE, getMaxStake } from "../utils/max-stake.util";

const ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

describe("max stake guard", () => {
  const original = { s: process.env.MAX_STAKE, p: process.env.MAX_PREDICTION_AMOUNT };

  afterEach(() => {
    for (const [key, val] of [["MAX_STAKE", original.s], ["MAX_PREDICTION_AMOUNT", original.p]] as const) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  beforeEach(() => {
    delete process.env.MAX_STAKE;
    delete process.env.MAX_PREDICTION_AMOUNT;
  });

  it("defaults to DEFAULT_MAX_STAKE and ignores invalid values", () => {
    expect(getMaxStake()).toBe(DEFAULT_MAX_STAKE);
    for (const bad of ["abc", "0", "-5", ""]) {
      process.env.MAX_STAKE = bad;
      expect(getMaxStake()).toBe(DEFAULT_MAX_STAKE);
    }
  });

  it("accepts an amount exactly at the default max and rejects above it", () => {
    const base = { address: ADDRESS, side: "UP" as const };
    expect(upDownBetSchema.safeParse({ ...base, amount: DEFAULT_MAX_STAKE }).success).toBe(true);
    const over = upDownBetSchema.safeParse({ ...base, amount: DEFAULT_MAX_STAKE + 1 });
    expect(over.success).toBe(false);
    if (!over.success) expect(over.error.issues[0].path).toEqual(["amount"]);
    expect(upDownBetSchema.safeParse({ ...base, amount: 1e15 }).success).toBe(false);
  });

  it("honours MAX_STAKE for bets, predictions and legends predictions", () => {
    process.env.MAX_STAKE = "500";

    expect(upDownBetSchema.safeParse({ address: ADDRESS, side: "UP", amount: 500 }).success).toBe(true);
    expect(upDownBetSchema.safeParse({ address: ADDRESS, side: "UP", amount: 500.01 }).success).toBe(false);

    expect(precisionBetSchema.safeParse({ address: ADDRESS, predictedPrice: 0.12, amount: 500 }).success).toBe(true);
    expect(precisionBetSchema.safeParse({ address: ADDRESS, predictedPrice: 0.12, amount: 501 }).success).toBe(false);

    expect(submitPredictionSchema.safeParse({ roundId: "r1", side: "UP", amount: 500 }).success).toBe(true);
    expect(submitPredictionSchema.safeParse({ roundId: "r1", side: "UP", amount: 501 }).success).toBe(false);

    const legends = { roundId: "3f0d4b1e-8a2c-4c39-9b7e-0c1d2e3f4a5b", priceRange: { min: 0.1, max: 0.2 } };
    expect(submitLegendsPredictionSchema.safeParse({ ...legends, amount: 500 }).success).toBe(true);
    expect(submitLegendsPredictionSchema.safeParse({ ...legends, amount: 501 }).success).toBe(false);
  });

  it("falls back to MAX_PREDICTION_AMOUNT when MAX_STAKE is unset", () => {
    process.env.MAX_PREDICTION_AMOUNT = "50";
    expect(getMaxStake()).toBe(50);
  });
});
