/**
 * Mock money columns must use the same Decimal(20, 8) contract as production
 * (issue #621).
 *
 * The hackathon "Mock*" models were originally declared as `Float` (and
 * `MockLeaderboard.balance` as `Int`), so mock-mode demos could drift from the
 * rest of the API. These tests read the Prisma schema and fail if a money
 * column ever goes back to a native float/integer type — the drift Prisma
 * cannot catch for us, because nothing in the app code would break until a
 * `1.99999997` pool shows up in a response.
 */
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "@jest/globals";
import { Decimal } from "@prisma/client/runtime/library";
import { decAdd, serializeMoney } from "../utils/decimal.util";

const SCHEMA_PATH = path.resolve(__dirname, "../../prisma/schema.prisma");
const schema = readFileSync(SCHEMA_PATH, "utf8");

/** Extracts the body of a `model <name> { ... }` block from the schema. */
function modelBody(name: string): string {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) {
    throw new Error(`model ${name} is missing from prisma/schema.prisma`);
  }
  return match[1];
}

function fieldLine(model: string, field: string): string {
  const line = modelBody(model)
    .split(/\r?\n/)
    .find((candidate) => new RegExp(`^\\s*${field}\\s`).test(candidate));
  if (!line) {
    throw new Error(`field ${model}.${field} is missing from prisma/schema.prisma`);
  }
  return line;
}

const MOCK_MONEY_FIELDS: Record<string, string[]> = {
  MockRound: ["startPrice", "poolUp", "poolDown", "totalPool"],
  MockLeaderboard: ["balance", "pendingWinnings"],
  MockBet: ["amount", "predictedPrice"],
  MockPlatformStat: ["totalVxlmDistributed"],
};

describe("Mock* monetary columns use Decimal(20, 8)", () => {
  it.each(Object.keys(MOCK_MONEY_FIELDS))(
    "%s declares no Float columns",
    (model) => {
      expect(modelBody(model)).not.toMatch(/\bFloat\b/);
    },
  );

  it.each(
    Object.entries(MOCK_MONEY_FIELDS).flatMap(([model, fields]) =>
      fields.map((field) => [model, field] as const),
    ),
  )("%s.%s is a Decimal(20, 8) column", (model, field) => {
    const line = fieldLine(model, field);
    expect(line).toMatch(/\bDecimal\??\b/);
    expect(line).toContain("@db.Decimal(20, 8)");
  });

  it("keeps MockBet.amount non-nullable so a bet always records its stake", () => {
    expect(fieldLine("MockBet", "amount")).not.toMatch(/Decimal\?/);
  });

  it("keeps optional money columns nullable", () => {
    for (const field of ["poolUp", "poolDown", "totalPool"]) {
      expect(fieldLine("MockRound", field)).toMatch(/Decimal\?/);
    }
    expect(fieldLine("MockBet", "predictedPrice")).toMatch(/Decimal\?/);
  });
});

describe("Mock monetary arithmetic stays exact", () => {
  it("keeps the classic 0.1 + 0.2 pool addition exact", () => {
    // Native floats: 0.30000000000000004 — the drift this migration removes.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(decAdd(0.1, 0.2).toString()).toBe("0.3");
  });

  it("serializes a mock balance as an 8-dp string, not a JSON number", () => {
    const balance = new Decimal("1000");
    expect(serializeMoney(balance)).toBe("1000.00000000");
    expect(typeof serializeMoney(balance)).toBe("string");
  });
});
