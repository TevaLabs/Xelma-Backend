import { precisionBetSchema, upDownBetSchema } from "../schemas/bets.schema";
import { DECIMAL_18_8_MAX, fitsDecimalPlaces } from "../utils/decimal.util";

const ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

function precision(amount: number, predictedPrice: number) {
  return precisionBetSchema.safeParse({ address: ADDRESS, amount, predictedPrice });
}

describe("precision bet decimal bounds", () => {
  it("accepts up to 8 decimal places", () => {
    expect(fitsDecimalPlaces(0.12)).toBe(true);
    expect(fitsDecimalPlaces(1.12345678)).toBe(true);
    expect(precision(1.12345678, 0.12345678).success).toBe(true);
  });

  it("rejects more than 8 decimal places", () => {
    expect(fitsDecimalPlaces(1.123456789)).toBe(false);
    const result = precision(1.123456789, 0.12);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join("."))).toContain("amount");
    }
  });

  it("rejects predictedPrice with sub-8-dp precision", () => {
    const result = precision(10, 0.1234567891);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["predictedPrice"]);
      expect(result.error.issues[0].message).toMatch(/8 decimal places/);
    }
  });

  it("rejects predictedPrice outside the Decimal(18, 8) range", () => {
    const max = Number(DECIMAL_18_8_MAX);
    expect(precision(10, max).success).toBe(true);
    const result = precision(10, max + 1);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["predictedPrice"]);
    }
  });

  it("still rejects non-positive and non-finite prices", () => {
    expect(precision(10, 0).success).toBe(false);
    expect(precision(10, -1).success).toBe(false);
    expect(precision(10, Number.POSITIVE_INFINITY).success).toBe(false);
  });

  it("keeps up-down bet validation unchanged", () => {
    expect(
      upDownBetSchema.safeParse({ address: ADDRESS, amount: 1.12345678, side: "UP" }).success,
    ).toBe(true);
  });
});
