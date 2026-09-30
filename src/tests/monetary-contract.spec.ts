import { describe, expect, it } from "@jest/globals";
import { swaggerSpec } from "../docs/openapi";
import { hackathonSwaggerSpec } from "../docs/hackathon-openapi";
import { MONEY_FIELD_NAMES } from "../serializers/monetary.serializer";

const RESPONSE_MONEY_FIELDS = [
  "amount",
  "balance",
  "payout",
  "poolUp",
  "poolDown",
  "totalPool",
  "entryFee",
  "prizePool",
  "startPrice",
  "endPrice",
  "totalEarnings",
  "upDownEarnings",
  "legendsEarnings",
  "pendingWinnings",
  "pool",
  "earnings",
];

function walk(
  node: unknown,
  path: string,
  onProperty: (name: string, schema: Record<string, unknown>, path: string) => void,
): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item, index) => walk(item, `${path}[${index}]`, onProperty));
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.properties && typeof obj.properties === "object") {
    for (const [name, schema] of Object.entries(obj.properties as Record<string, unknown>)) {
      onProperty(name, (schema as Record<string, unknown>) ?? {}, `${path}.properties.${name}`);
      walk(schema, `${path}.properties.${name}`, onProperty);
    }
  }
  for (const [key, child] of Object.entries(obj)) {
    if (key === "properties") continue;
    walk(child, `${path}.${key}`, onProperty);
  }
}

function isNumberTyped(schema: Record<string, unknown>): boolean {
  if (schema.type === "number" || schema.type === "integer") return true;
  const allOf = schema.allOf;
  if (Array.isArray(allOf)) {
    return allOf.some((item) => isNumberTyped((item as Record<string, unknown>) ?? {}));
  }
  return false;
}

function refsMoneyAmount(schema: Record<string, unknown>): boolean {
  const ref = typeof schema.$ref === "string" ? schema.$ref : "";
  if (ref.endsWith("/MoneyAmount") || ref.endsWith("/NullableMoneyAmount")) return true;
  const allOf = schema.allOf;
  if (Array.isArray(allOf)) {
    return allOf.some((item) => refsMoneyAmount((item as Record<string, unknown>) ?? {}));
  }
  return schema.type === "string";
}

describe("OpenAPI monetary contract", () => {
  it("declares canonical MoneyAmount schemas", () => {
    const schemas = (swaggerSpec as { components?: { schemas?: Record<string, unknown> } })
      .components?.schemas;
    expect(schemas?.MoneyAmount).toBeDefined();
    expect(schemas?.NullableMoneyAmount).toBeDefined();
    expect((schemas?.MoneyAmount as { type?: string }).type).toBe("string");
  });

  it.each([
    ["production", swaggerSpec],
    ["hackathon", hackathonSwaggerSpec],
  ])("%s spec does not type response money fields as JSON numbers", (_label, spec) => {
    const violations: string[] = [];
    walk(spec, "$", (name, schema, path) => {
      if (!RESPONSE_MONEY_FIELDS.includes(name) && !MONEY_FIELD_NAMES.has(name)) {
        return;
      }
      if (path.includes(".requestBody.")) {
        return;
      }
      if (isNumberTyped(schema) && !refsMoneyAmount(schema)) {
        violations.push(path);
      }
    });
    expect(violations).toEqual([]);
  });
});
