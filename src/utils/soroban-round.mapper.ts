import type { Round as SorobanRound } from "@tevalabs/xelma-bindings";
import { RoundMode } from "@tevalabs/xelma-bindings";

const PRICE_SCALE = 10_000;
const STROOP_SCALE = 10_000_000;

export type ActiveRoundSource = "soroban" | "database" | "none";

export interface MappedActiveRound {
  id: string;
  sorobanRoundId: string;
  mode: "UP_DOWN" | "LEGENDS";
  status: "ACTIVE";
  startPrice: number;
  poolUp: number;
  poolDown: number;
  startLedger: number;
  betEndLedger: number;
  endLedger: number;
  isSoroban: true;
  source: "soroban";
}

function toNumber(value: bigint | number | string): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number(value);
}

export function mapSorobanActiveRound(round: SorobanRound): MappedActiveRound {
  const roundId = toNumber(round.round_id);
  const mode =
    (round.mode as any) === RoundMode.Precision || (round.mode as any) === 1 ? "LEGENDS" : "UP_DOWN";

  return {
    id: `soroban-${roundId}`,
    sorobanRoundId: String(roundId),
    mode,
    status: "ACTIVE",
    startPrice: toNumber(round.price_start) / PRICE_SCALE,
    poolUp: toNumber(round.pool_up) / STROOP_SCALE,
    poolDown: toNumber(round.pool_down) / STROOP_SCALE,
    startLedger: Number(round.start_ledger),
    betEndLedger: Number(round.bet_end_ledger),
    endLedger: Number(round.end_ledger),
    isSoroban: true,
    source: "soroban",
  };
}

export function mapDatabaseActiveRound(round: Record<string, unknown>): Record<string, unknown> {
  return {
    ...round,
    source: "database" as const,
  };
}
