import {
  serializeMoney,
  serializeNullableMoney,
  type MoneyInput,
} from "../utils/decimal.util";
import type { RoundUpdatePayload } from "../types/socket-events";

/** Field names that must never appear as JSON numbers in API payloads. */
export const MONEY_FIELD_NAMES = new Set([
  "amount",
  "balance",
  "payout",
  "poolUp",
  "poolDown",
  "totalPool",
  "upPool",
  "downPool",
  "entryFee",
  "prizePool",
  "startPrice",
  "endPrice",
  "currentPrice",
  "totalEarnings",
  "upDownEarnings",
  "legendsEarnings",
  "pendingWinnings",
  "bonus",
  "pool",
  "amount",
  "payout",
  "entryFee",
  "prizePool",
  "earnings",
]);

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function serializeExisting(
  obj: Record<string, unknown>,
  key: string,
  optional: boolean,
): void {
  if (!hasOwn(obj, key)) return;
  obj[key] = optional
    ? serializeNullableMoney(obj[key] as MoneyInput)
    : serializeMoney(obj[key] as MoneyInput);
}

export function serializePriceRanges(ranges: unknown): unknown {
  if (!Array.isArray(ranges)) return ranges;
  return ranges.map((range) => {
    if (!range || typeof range !== "object") return range;
    const row = { ...(range as Record<string, unknown>) };
    serializeExisting(row, "pool", false);
    return row;
  });
}

export function serializePrediction<T extends object>(prediction: T): T {
  const out = { ...prediction } as Record<string, unknown>;
  serializeExisting(out, "amount", false);
  serializeExisting(out, "payout", true);
  serializeExisting(out, "amount", false);
  serializeExisting(out, "payout", true);
  if (out.round && typeof out.round === "object") {
    out.round = serializeRound(out.round as Record<string, unknown>);
  }
  return out as T;
}

export function serializeRound<T extends object>(round: T): T {
  const out = { ...round } as Record<string, unknown>;

  // Keep timer clients on server time. `endTime` is the canonical persisted
  // close/lock boundary; clamp the derived value so clock skew never yields a
  // negative countdown.
  const endTime = out.endTime;
  const endDate = endTime instanceof Date
    ? endTime
    : typeof endTime === "string"
      ? new Date(endTime)
      : null;
  if (endDate && !Number.isNaN(endDate.getTime())) {
    const endIso = endDate.toISOString();
    out.bettingClosesAt = endIso;
    out.lockAt = endIso;
    out.resolveAt = out.resolvedAt ?? null;
    out.secondsRemaining = Math.max(0, Math.ceil((endDate.getTime() - Date.now()) / 1000));
  }

  serializeExisting(out, "startPrice", false);
  serializeExisting(out, "currentPrice", false);
  serializeExisting(out, "endPrice", true);
  serializeExisting(out, "poolUp", false);
  serializeExisting(out, "poolDown", false);
  serializeExisting(out, "totalPool", false);

  if (Array.isArray(out.predictions)) {
    out.predictions = out.predictions.map((prediction) =>
      serializePrediction(prediction as Record<string, unknown>),
    );
  }
  if (hasOwn(out, "priceRanges")) {
    out.priceRanges = serializePriceRanges(out.priceRanges);
  }
  if (out.priceData && typeof out.priceData === "object") {
    const priceData = { ...(out.priceData as Record<string, unknown>) };
    serializeExisting(priceData, "startPrice", false);
    serializeExisting(priceData, "currentPrice", false);
    out.priceData = priceData;
  }
  if (out.poolValues && typeof out.poolValues === "object") {
    const poolValues = { ...(out.poolValues as Record<string, unknown>) };
    serializeExisting(poolValues, "upPool", false);
    serializeExisting(poolValues, "downPool", false);
    serializeExisting(poolValues, "totalPool", false);
    out.poolValues = poolValues;
  }

  return out as T;
}

export function serializeUserBalance<T extends object>(payload: T): T {
  const out = { ...payload } as Record<string, unknown>;
  serializeExisting(out, "balance", false);
  serializeExisting(out, "pendingWinnings", false);
  return out as T;
}

export function serializeUserStats<T extends object>(stats: T): T {
  const out = { ...stats } as Record<string, unknown>;
  serializeExisting(out, "totalEarnings", false);
  serializeExisting(out, "upDownEarnings", false);
  serializeExisting(out, "legendsEarnings", false);
  serializeExisting(out, "pendingWinnings", false);
  return out as T;
}

export function serializeTransaction<T extends object>(tx: T): T {
  const out = { ...tx } as Record<string, unknown>;
  serializeExisting(out, "amount", false);
  return out as T;
}

export function serializeTournament<T extends object>(tournament: T): T {
  const out = { ...tournament } as Record<string, unknown>;
  serializeExisting(out, "entryFee", false);
  serializeExisting(out, "prizePool", false);
  serializeExisting(out, "entryFee", false);
  serializeExisting(out, "prizePool", false);
  return out as T;
}

export function serializeBet<T extends object>(bet: T): T {
  const out = { ...bet } as Record<string, unknown>;
  serializeExisting(out, "amount", false);
  return out as T;
}

export function serializeRoundUpdatePayload(round: Record<string, unknown>): RoundUpdatePayload {
  const startTime =
    typeof (round.startTime as { toISOString?: () => string })?.toISOString === "function"
      ? (round.startTime as Date).toISOString()
      : round.startTime;
  const endTime =
    typeof (round.endTime as { toISOString?: () => string })?.toISOString === "function"
      ? (round.endTime as Date).toISOString()
      : round.endTime;
  const resolvedAt =
    typeof (round.resolvedAt as { toISOString?: () => string })?.toISOString === "function"
      ? (round.resolvedAt as Date).toISOString()
      : (round.resolvedAt as string | null | undefined) ?? null;

  return {
    id: String(round.id ?? ""),
    mode: String(round.mode ?? ""),
    status: String(round.status ?? ""),
    startTime: (startTime as string | null | undefined) ?? null,
    endTime: (endTime as string | null | undefined) ?? null,
    startPrice: serializeNullableMoney(round.startPrice as MoneyInput),
    endPrice: serializeNullableMoney(round.endPrice as MoneyInput),
    poolUp: serializeMoney((round.poolUp ?? 0) as MoneyInput),
    poolDown: serializeMoney((round.poolDown ?? 0) as MoneyInput),
    priceRanges: serializePriceRanges(round.priceRanges),
    resolvedAt,
  };
}

/**
 * Recursively assert that known money keys are decimal strings (or null).
 * Used by contract tests so a JSON number on a money field fails CI.
 */
export function assertNoNumericMoney(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoNumericMoney(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (MONEY_FIELD_NAMES.has(key) && child !== undefined) {
      if (typeof child === "number") {
        throw new Error(
          `Money field ${childPath} must be a decimal string, got number ${child}`,
        );
      }
      if (child !== null && typeof child !== "string") {
        throw new Error(
          `Money field ${childPath} must be a decimal string or null, got ${typeof child}`,
        );
      }
    }
    assertNoNumericMoney(child, childPath);
  }
}
