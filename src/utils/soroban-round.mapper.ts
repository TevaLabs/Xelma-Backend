import type { Round as SorobanRound } from "@tevalabs/xelma-bindings";
import { RoundMode } from "@tevalabs/xelma-bindings";
import {
  serializeMoney,
  serializeNullableMoney,
  type MoneyInput,
} from "./decimal.util";
import { serializeRound } from "../serializers/monetary.serializer";
import type {
  RoundListItem,
  RoundSource,
} from "../repositories/interfaces";

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

/**
 * Explicitly map a serialized round to the API contract (Issue #661).
 *
 * Every field is copied by name — no `as` cast — so adding a field to the
 * source without adding it here is a visible omission rather than a silent
 * type lie, and a source cannot smuggle internal columns (e.g. `userId`)
 * into the public payload.
 */
function toRoundListItem(
  input: Record<string, unknown>,
  source: RoundSource,
): RoundListItem {
  const serialized = serializeRound({ ...input });

  const item: RoundListItem = {
    id: String(serialized.id ?? ""),
    mode: String(serialized.mode ?? ""),
    status: String(serialized.status ?? ""),
    source,
    startPrice: serializeMoney(serialized.startPrice as MoneyInput),
  };

  // Soroban on-chain fields.
  if (serialized.sorobanRoundId !== undefined && serialized.sorobanRoundId !== null) {
    item.sorobanRoundId = String(serialized.sorobanRoundId);
  }
  if (typeof serialized.startLedger === "number") {
    item.startLedger = serialized.startLedger;
  }
  if (typeof serialized.betEndLedger === "number") {
    item.betEndLedger = serialized.betEndLedger;
  }
  if (typeof serialized.endLedger === "number") {
    item.endLedger = serialized.endLedger;
  }
  if (serialized.isSoroban !== undefined) {
    item.isSoroban = Boolean(serialized.isSoroban);
  }

  // Money pools.
  if (serialized.poolUp !== undefined) {
    item.poolUp = serializeMoney(serialized.poolUp as MoneyInput);
  }
  if (serialized.poolDown !== undefined) {
    item.poolDown = serializeMoney(serialized.poolDown as MoneyInput);
  }
  if (serialized.totalPool !== undefined) {
    item.totalPool = serializeMoney(serialized.totalPool as MoneyInput);
  }
  if (serialized.endPrice !== undefined) {
    item.endPrice = serializeNullableMoney(serialized.endPrice as MoneyInput);
  }

  // Database timestamps.
  if (serialized.startTime !== undefined) {
    item.startTime = serialized.startTime as string | Date;
  }
  if (serialized.endTime !== undefined) {
    item.endTime = serialized.endTime as string | Date;
  }
  if (serialized.resolvedAt !== undefined) {
    item.resolvedAt = serialized.resolvedAt as string | Date | null;
  }
  if (serialized.createdAt !== undefined) {
    item.createdAt = serialized.createdAt as string | Date;
  }
  if (serialized.updatedAt !== undefined) {
    item.updatedAt = serialized.updatedAt as string | Date;
  }
  if (serialized.priceRanges !== undefined) {
    item.priceRanges = serialized.priceRanges;
  }
  if (typeof serialized.bettingClosesAt === "string") {
    item.bettingClosesAt = serialized.bettingClosesAt;
  }
  if (typeof serialized.lockAt === "string") {
    item.lockAt = serialized.lockAt;
  }
  if (serialized.resolveAt !== undefined) {
    item.resolveAt = serialized.resolveAt as string | Date | null;
  }
  if (typeof serialized.secondsRemaining === "number") {
    item.secondsRemaining = serialized.secondsRemaining;
  }

  // Mock seed fields.
  if (serialized.asset !== undefined) {
    item.asset = String(serialized.asset);
  }
  if (typeof serialized.predictionCount === "number") {
    item.predictionCount = serialized.predictionCount;
  }
  if (serialized.closesAt !== undefined && serialized.closesAt !== null) {
    item.closesAt = String(serialized.closesAt);
  }

  return item;
}

export function mapDatabaseActiveRound(
  round: Record<string, unknown>,
): RoundListItem {
  return toRoundListItem({ ...round }, "database");
}

export function mapMockActiveRound(
  round: Record<string, unknown>,
): RoundListItem {
  return toRoundListItem({ ...round }, "mock");
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
