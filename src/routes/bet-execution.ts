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
  acquireIdempotencyLock,
  IDEMPOTENCY_STORE_UNAVAILABLE,
  IdempotencyStoreUnavailableError,
  releaseIdempotencyLock,
  storeIdempotencyResult,
  isValidIdempotencyKey,
} from "../utils/idempotency.util";
import {
  DistributedIdempotencyLockUnavailableError,
  withDistributedIdempotencyLock,
} from "../utils/distributed-idempotency-lock";
import {
  ConflictError,
  ValidationError,
  ErrorCode,
  ExternalServiceError,
} from "../utils/errors";
import { sendSuccess } from "../utils/response";

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
): Promise<BetResult> {
  if (kind === "up-down") {
    const input: UpDownBetInput = {
      address: body.address,
      amount: body.amount,
      side: body.side,
      ...(roundId ? { roundId } : {}),
    };
    return betService.recordUpDownBet(input, idempotencyKey);
  }

  const input: PrecisionBetInput = {
    address: body.address,
    amount: body.amount,
    predictedPrice: body.predictedPrice,
    ...(roundId ? { roundId } : {}),
  };
  return betService.recordPrecisionBet(input, idempotencyKey);
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
  const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
  const userId = req.user.userId;
  let lockAcquired = false;
  let operationCompleted = false;

  const execute = async () => {
    if (idempotencyKey) {
      if (!isValidIdempotencyKey(idempotencyKey)) {
        throw new ValidationError(
          "Invalid Idempotency-Key format. Must be 8-255 alphanumeric characters.",
        );
      }

      const lockResult = await acquireIdempotencyLock(
        userId,
        endpoint,
        idempotencyKey,
        req.body,
        IDEMPOTENCY_TTL_HOURS,
      );

      if (lockResult.isIdempotent && lockResult.cachedResponse) {
        return res
          .status(lockResult.cachedResponse.status)
          .json(lockResult.cachedResponse.body);
      }

      if (lockResult.error === IDEMPOTENCY_STORE_UNAVAILABLE) {
        throw new ExternalServiceError(
          "Idempotency store unavailable. Please try again.",
          ErrorCode.EXTERNAL_SERVICE_ERROR,
        );
      }

      if (lockResult.error) {
        throw new ConflictError(
          lockResult.error,
          ErrorCode.IDEMPOTENCY_KEY_CONFLICT,
        );
      }

      lockAcquired = !!lockResult.lockAcquired;
    }

    const result = await placeBet(kind, req.body, roundId, idempotencyKey);
    operationCompleted = true;

    const data = toBetResponseData(kind, result);
    const responseBody = { success: true as const, data };

    if (idempotencyKey && lockAcquired) {
      await storeIdempotencyResult(
        userId,
        endpoint,
        idempotencyKey,
        req.body,
        200,
        responseBody,
        { ttlHours: IDEMPOTENCY_TTL_HOURS },
      );
    }

    return sendSuccess(res, data);
  };

  try {
    if (idempotencyKey) {
      // Fail-closed distributed lock (Redis) in front of the Prisma flow so
      // concurrent replicas cannot both process the same key.
      await withDistributedIdempotencyLock(
        userId,
        endpoint,
        idempotencyKey,
        execute,
      );
    } else {
      await execute();
    }
  } catch (error: any) {
    if (idempotencyKey && lockAcquired && !operationCompleted) {
      await releaseIdempotencyLock(userId, endpoint, idempotencyKey);
    }

    if (error instanceof DistributedIdempotencyLockUnavailableError) {
      return next(
        new ExternalServiceError(
          "Distributed idempotency lock unavailable. Please try again.",
          ErrorCode.EXTERNAL_SERVICE_ERROR,
        ),
      );
    }

    if (error instanceof IdempotencyStoreUnavailableError) {
      return next(
        new ExternalServiceError(
          "Idempotency store unavailable. Please try again.",
          ErrorCode.EXTERNAL_SERVICE_ERROR,
        ),
      );
    }

    return next(error);
  }
}
