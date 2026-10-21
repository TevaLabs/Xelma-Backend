import type { Round as SorobanRound } from "@tevalabs/xelma-bindings";
import { RoundMode } from "@tevalabs/xelma-bindings";
import { serializeMoney } from "./decimal.util";
import { serializeRound } from "../serializers/monetary.serializer";
import type { RoundListItem } from "../repositories/interfaces";

const PRICE_SCALE = 10_000;
const STROOP_SCALE = 10_000_000;

export type ActiveRoundSource = "soroban" | "database" | "mock" | "none";

export interface MappedActiveRound {
  id: string;
  sorobanRoundId: string;
  mode: "UP_DOWN" | "LEGENDS";
  status: "ACTIVE";
  startPrice: string;
  poolUp: string;
  poolDown: string;
  startLedger: number;
  betEndLedger: number;
  endLedger: number;
  isSoroban: true;
  source: "soroban";
}

export interface FrontendRoundCard {
  id: string;
  asset: string;
  mode: string;
  status: string;
  startPrice: string;
  poolUp: string;
  poolDown: string;
  totalPool: string;
  predictionCount: number;
  closesAt: string;
  source: "live" | "mock";
  roundStatus: string;
  roundTiming: {
    startsAt: string;
    endsAt: string;
  };
  priceData: {
    startPrice: string;
    currentPrice: string;
    change24h?: number;
  };
  poolValues: {
    upPool: string;
    downPool: string;
    totalPool: string;
  };
  predictionMetadata: {
    predictionCount: number;
    canPredict: boolean;
    roundId?: string;
    sorobanRoundId?: string;
  };
  [key: string]: unknown;
}

function toNumber(value: bigint | number | string | undefined | null): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return 0;
}

/**
 * Narrows a Soroban round's mode into the API's discriminated shape.
 * Throws instead of silently defaulting so an unrecognized mode value
 * (e.g. a contract ABI change) fails loudly rather than slipping into
 * an API response as UP_DOWN.
 */
export function resolveRoundMode(mode: RoundMode): "UP_DOWN" | "LEGENDS" {
  switch (mode) {
    case RoundMode.UpDown:
      return "UP_DOWN";
    case RoundMode.Precision:
      return "LEGENDS";
    default:
      throw new Error(`Unsupported Soroban round mode: ${String(mode)}`);
  }
}

export function mapSorobanActiveRound(round: SorobanRound): MappedActiveRound {
  const roundId = toNumber(round.round_id);
  const mode = resolveRoundMode(round.mode);

  return {
    id: `soroban-${roundId}`,
    sorobanRoundId: String(roundId),
    mode,
    status: "ACTIVE",
    startPrice: serializeMoney(toNumber(round.price_start) / PRICE_SCALE),
    poolUp: serializeMoney(toNumber(round.pool_up) / STROOP_SCALE),
    poolDown: serializeMoney(toNumber(round.pool_down) / STROOP_SCALE),
    startLedger: Number(round.start_ledger),
    betEndLedger: Number(round.bet_end_ledger),
    endLedger: Number(round.end_ledger),
    isSoroban: true,
    source: "soroban",
  };
}

export function mapDatabaseActiveRound(
  round: Record<string, unknown>,
): RoundListItem {
  return serializeRound({
    ...round,
    source: "database" as const,
  }) as RoundListItem;
}

export function mapMockActiveRound(
  round: Record<string, unknown>,
): RoundListItem {
  return serializeRound({
    ...round,
    source: "mock" as const,
  }) as RoundListItem;
}

const MOCK_ASSETS = [
  { asset: "BTC", symbol: "BTC", label: "Bitcoin" },
  { asset: "ETH", symbol: "ETH", label: "Ethereum" },
  { asset: "XLM", symbol: "XLM", label: "Stellar" },
] as const;

function buildMockFrontendCard(
  asset: string,
  index: number,
): FrontendRoundCard {
  const startPrice = asset === "BTC" ? 60000 : asset === "ETH" ? 3000 : 0.12;
  const currentPrice = asset === "BTC" ? 61000 : asset === "ETH" ? 3050 : 0.13;
  const upPool = asset === "BTC" ? 1800 : asset === "ETH" ? 1200 : 250;
  const downPool = asset === "BTC" ? 1400 : asset === "ETH" ? 950 : 150;
  const totalPool = upPool + downPool;

  return serializeRound({
    id: `${asset.toLowerCase()}-round-${index + 1}`,
    asset,
    mode: "updown",
    status: "live",
    startPrice,
    poolUp: upPool,
    poolDown: downPool,
    totalPool,
    predictionCount: asset === "BTC" ? 4 : asset === "ETH" ? 7 : 2,
    closesAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    source: "mock",
    roundStatus: "ACTIVE",
    roundTiming: {
      startsAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      endsAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    },
    priceData: {
      startPrice,
      currentPrice,
    },
    poolValues: {
      upPool,
      downPool,
      totalPool,
    },
    predictionMetadata: {
      predictionCount: asset === "BTC" ? 4 : asset === "ETH" ? 7 : 2,
      canPredict: true,
    },
  }) as unknown as FrontendRoundCard;
}

function buildLiveFrontendCard(
  round: SorobanRound | null,
): FrontendRoundCard | null {
  if (!round) return null;

  const mappedRound = mapSorobanActiveRound(round);
  const startPrice = toNumber(round.price_start) / PRICE_SCALE;
  const currentPrice = startPrice * 1.01;
  const upPool = toNumber(round.pool_up) / STROOP_SCALE;
  const downPool = toNumber(round.pool_down) / STROOP_SCALE;
  const totalPool = upPool + downPool;

  return serializeRound({
    id: mappedRound.id,
    asset: "XLM",
    mode: mappedRound.mode === "LEGENDS" ? "precision" : "updown",
    status: "live",
    startPrice,
    poolUp: upPool,
    poolDown: downPool,
    totalPool,
    predictionCount: 1,
    closesAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    source: "live",
    roundStatus: mappedRound.status,
    roundTiming: {
      startsAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      endsAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    },
    priceData: {
      startPrice,
      currentPrice,
    },
    poolValues: {
      upPool,
      downPool,
      totalPool,
    },
    predictionMetadata: {
      predictionCount: 1,
      canPredict: true,
      roundId: mappedRound.id,
      sorobanRoundId: mappedRound.sorobanRoundId,
    },
    sorobanRoundId: mappedRound.sorobanRoundId,
    isSoroban: mappedRound.isSoroban,
  }) as unknown as FrontendRoundCard;
}

/** One `roundId -> sorobanRoundId` pair accepted by the backfill CLI. */
export interface SorobanRoundIdMappingEntry {
  roundId: string;
  sorobanRoundId: string;
}

export interface BackfillRound {
  id: string;
  sorobanRoundId: string | null;
}

export type BackfillSkipReason =
  | "unknown_round"
  | "already_applied"
  | "already_assigned"
  | "soroban_id_taken";

export interface SorobanRoundBackfillPlan {
  updates: { roundId: string; sorobanRoundId: string }[];
  skipped: { roundId: string; sorobanRoundId: string; reason: BackfillSkipReason }[];
}

const SOROBAN_ROUND_ID_PATTERN = /^\d+$/;

/** Soroban round ids are positive u64 integers. */
export function isValidSorobanRoundId(value: string): boolean {
  return SOROBAN_ROUND_ID_PATTERN.test(value) && Number(value) > 0;
}

/**
 * Parses the operator-supplied mapping used by the backfill CLI. Accepts either
 * `{ "<roundId>": "<sorobanRoundId>" }` or an array of `roundId`/`sorobanRoundId`
 * objects. Strict on purpose: a typo must fail the run, not skip a round.
 */
export function parseSorobanRoundIdMapping(raw: unknown): SorobanRoundIdMappingEntry[] {
  const entries = Array.isArray(raw)
    ? raw.map((item, index) => {
        if (
          !item ||
          typeof item !== "object" ||
          typeof (item as any).roundId !== "string" ||
          (typeof (item as any).sorobanRoundId !== "string" &&
            typeof (item as any).sorobanRoundId !== "number")
        ) {
          throw new Error(
            `Invalid mapping entry at index ${index}: expected { roundId, sorobanRoundId }`,
          );
        }
        return {
          roundId: (item as any).roundId,
          sorobanRoundId: String((item as any).sorobanRoundId),
        };
      })
    : raw && typeof raw === "object"
      ? Object.entries(raw as Record<string, unknown>).map(([roundId, sorobanRoundId]) => ({
          roundId,
          sorobanRoundId: String(sorobanRoundId),
        }))
      : null;

  if (!entries) {
    throw new Error("Mapping must be a JSON object or an array of entries");
  }

  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.roundId.trim()) {
      throw new Error("Mapping contains an empty roundId");
    }
    if (!isValidSorobanRoundId(entry.sorobanRoundId)) {
      throw new Error(
        `Invalid sorobanRoundId for round ${entry.roundId}: ${entry.sorobanRoundId}`,
      );
    }
    if (seen.has(entry.roundId)) {
      throw new Error(`Duplicate mapping entry for round ${entry.roundId}`);
    }
    seen.add(entry.roundId);
  }

  return entries;
}

/**
 * Builds a dry-run plan for backfilling historical `Round.sorobanRoundId`
 * values (Issue #824). Pure so the CLI's dry-run and apply paths share exactly
 * the same decisions.
 */
export function planSorobanRoundBackfill(
  rounds: BackfillRound[],
  entries: SorobanRoundIdMappingEntry[],
): SorobanRoundBackfillPlan {
  const byId = new Map(rounds.map((round) => [round.id, round]));
  const claimedBy = new Map<string, string>();
  for (const round of rounds) {
    if (round.sorobanRoundId) claimedBy.set(round.sorobanRoundId, round.id);
  }

  const plan: SorobanRoundBackfillPlan = { updates: [], skipped: [] };

  for (const entry of entries) {
    const round = byId.get(entry.roundId);
    if (!round) {
      plan.skipped.push({ ...entry, reason: "unknown_round" });
      continue;
    }
    if (round.sorobanRoundId === entry.sorobanRoundId) {
      plan.skipped.push({ ...entry, reason: "already_applied" });
      continue;
    }
    if (round.sorobanRoundId) {
      plan.skipped.push({ ...entry, reason: "already_assigned" });
      continue;
    }
    const owner = claimedBy.get(entry.sorobanRoundId);
    if (owner && owner !== round.id) {
      plan.skipped.push({ ...entry, reason: "soroban_id_taken" });
      continue;
    }
    claimedBy.set(entry.sorobanRoundId, round.id);
    plan.updates.push({ roundId: round.id, sorobanRoundId: entry.sorobanRoundId });
  }

  return plan;
}

export function mapSorobanRoundToFrontendCards(
  round: SorobanRound | null,
): FrontendRoundCard[] {
  const cards: FrontendRoundCard[] = [];
  const liveCard = buildLiveFrontendCard(round);

  if (liveCard) {
    cards.push(liveCard);
  }

  const mockAssets = MOCK_ASSETS.filter(({ asset }) => asset !== "XLM");
  const mockCards = mockAssets.map((asset, index) =>
    buildMockFrontendCard(asset.asset, index),
  );

  if (liveCard) {
    cards.push(...mockCards);
  } else {
    cards.push(
      ...MOCK_ASSETS.map((asset, index) =>
        buildMockFrontendCard(asset.asset, index),
      ),
    );
  }

  return cards;
}
