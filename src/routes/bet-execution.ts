/**
 * Shared bet execution path.
 *
 * `/api/bets/*` and the round-scoped `/api/rounds/*` bet endpoints both run
 * through `executeBet`, so idempotency handling, `BET_STUB_MODE` semantics,
 * audit/outbox side effects and the success envelope cannot drift between the
 * two families of routes. The only difference between callers is which
 * BetService method they hand over and whether a round id is bound.
 */
import { Response, NextFunction } from "express";
import betService, {
  BetResult,
  PrecisionBetInput,
  UpDownBetInput,
} from "../services/bet.service";
import {
  IDEMPOTENT_REPLAYED_HEADER,
  readIdempotencyKey,
  runIdempotent,
} from "../utils/idempotency.util";
import { invalidateNamespace } from "../lib/redis";

const IDEMPOTENCY_TTL_HOURS = 24;

export type BetKind = "up-down" | "precision";

export interface BetResponseData {
  message: string;
  state: string;
  betId: string;
  status: string;
  txHash?: string;
}

/**
 * Place the bet through BetService. `roundId` is passed straight to the
 * service, which validates it against the round's mode.
 */
async function placeBet(
  kind: BetKind,
  body: Record<string, any>,
  roundId: string | undefined,
  idempotencyKey: string | undefined,
  requestId?: string,
): Promise<BetResult> {
  if (kind === "up-down") {
    const input: UpDownBetInput = {
      address: body.address,
      amount: body.amount,
      side: body.side,
      ...(roundId ? { roundId } : {}),
    };
    return betService.recordUpDownBet(input, idempotencyKey, requestId);
  }

  const input: PrecisionBetInput = {
    address: body.address,
    amount: body.amount,
    predictedPrice: body.predictedPrice,
    ...(roundId ? { roundId } : {}),
  };
  return betService.recordPrecisionBet(input, idempotencyKey, requestId);
}

export function toBetResponseData(
  kind: BetKind,
  result: BetResult,
): BetResponseData {
  const stub = result.state === "stub";
  const label = kind === "precision" ? "Precision bet" : "Bet";

  return {
    message: stub ? `${label} recorded (stub)` : `${label} placed on-chain`,
    state: result.state,
    betId: result.betId,
    status: result.status,
    ...(result.txHash ? { txHash: result.txHash } : {}),
  };
}

export interface ExecuteBetOptions {
  kind: BetKind;
  /** Idempotency scope; must be stable per logical endpoint. */
  endpoint: string;
  /** Bind the bet to a specific round (round-scoped routes only). */
  roundId?: string;
}

/**
 * Run one bet request end to end: optional idempotency lock, BetService call,
 * cached-response replay, and the shared success envelope. On-chain failures
 * propagate out of BetService and are surfaced by the shared error handler as
 * structured errors, exactly as they are for `/api/bets/*`.
 */
export async function executeBet(
  req: any,
  res: Response,
  next: NextFunction,
  { kind, endpoint, roundId }: ExecuteBetOptions,
): Promise<void> {
  const idempotencyKey = readIdempotencyKey(req.headers);
  const requestId = (req as any).requestId as string | undefined;

  try {
    const result = await runIdempotent({
      userId: req.user.userId,
      endpoint,
      idempotencyKey,
      requestBody: req.body,
      ttlHours: IDEMPOTENCY_TTL_HOURS,
      operation: async () => {
        const bet = await placeBet(kind, req.body, roundId, idempotencyKey, requestId);

        void invalidateNamespace("bets").catch(() => {});
        void invalidateNamespace("rounds").catch(() => {});
        void invalidateNamespace("leaderboard").catch(() => {});
        void invalidateNamespace("stats").catch(() => {});

        return {
          status: 200,
          body: { success: true as const, data: toBetResponseData(kind, bet) },
        };
      },
    });

    if (result.replayed) {
      res.setHeader(IDEMPOTENT_REPLAYED_HEADER, "true");
    }
    res.status(result.status).json(result.body);
  } catch (error) {
    next(error);
  }
}
