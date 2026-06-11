import logger from './logger';
import {
  circuitBreakerState,
  circuitBreakerStateChangesTotal,
} from '../middleware/metrics.middleware';

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold?: number;
  openBackoffMs?: number;
  halfOpenMaxCalls?: number;
  now?: () => number;
}

export interface CircuitBreakerSnapshot {
  name: string;
  state: CircuitBreakerState;
  failureCount: number;
  openedAt: Date | null;
  nextAttemptAt: Date | null;
  halfOpenInFlight: number;
}

export class CircuitBreakerOpenError extends Error {
  constructor(
    public readonly breakerName: string,
    public readonly nextAttemptAt: Date,
  ) {
    super(`Circuit breaker "${breakerName}" is open until ${nextAttemptAt.toISOString()}`);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitBreakerState = 'closed';
  private failureCount = 0;
  private openedAtMs: number | null = null;
  private nextAttemptAtMs: number | null = null;
  private halfOpenInFlight = 0;
  private readonly failureThreshold: number;
  private readonly openBackoffMs: number;
  private readonly halfOpenMaxCalls: number;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.openBackoffMs = options.openBackoffMs ?? 30_000;
    this.halfOpenMaxCalls = options.halfOpenMaxCalls ?? 1;
    this.now = options.now ?? Date.now;
    circuitBreakerState.set({ breaker: this.options.name, state: this.state }, 1);
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.beforeCall();

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  getSnapshot(): CircuitBreakerSnapshot {
    return {
      name: this.options.name,
      state: this.state,
      failureCount: this.failureCount,
      openedAt: this.openedAtMs === null ? null : new Date(this.openedAtMs),
      nextAttemptAt: this.nextAttemptAtMs === null ? null : new Date(this.nextAttemptAtMs),
      halfOpenInFlight: this.halfOpenInFlight,
    };
  }

  reset(reason = 'manual_reset'): void {
    this.failureCount = 0;
    this.openedAtMs = null;
    this.nextAttemptAtMs = null;
    this.halfOpenInFlight = 0;
    this.transitionTo('closed', reason);
  }

  private beforeCall(): void {
    if (this.state === 'open') {
      if (this.nextAttemptAtMs !== null && this.now() >= this.nextAttemptAtMs) {
        this.transitionTo('half-open', 'cooldown_elapsed');
      } else {
        throw new CircuitBreakerOpenError(
          this.options.name,
          new Date(this.nextAttemptAtMs ?? this.now() + this.openBackoffMs),
        );
      }
    }

    if (this.state === 'half-open') {
      if (this.halfOpenInFlight >= this.halfOpenMaxCalls) {
        throw new CircuitBreakerOpenError(
          this.options.name,
          new Date(this.nextAttemptAtMs ?? this.now() + this.openBackoffMs),
        );
      }
      this.halfOpenInFlight += 1;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      this.failureCount = 0;
      this.openedAtMs = null;
      this.nextAttemptAtMs = null;
      this.transitionTo('closed', 'half_open_probe_succeeded');
      return;
    }

    this.failureCount = 0;
  }

  private onFailure(error: unknown): void {
    if (this.state === 'half-open') {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      this.open('half_open_probe_failed', error);
      return;
    }

    this.failureCount += 1;
    if (this.failureCount >= this.failureThreshold) {
      this.open('failure_threshold_reached', error);
    }
  }

  private open(reason: string, error?: unknown): void {
    const now = this.now();
    this.openedAtMs = now;
    this.nextAttemptAtMs = now + this.openBackoffMs;
    this.transitionTo('open', reason, error);
  }

  private transitionTo(nextState: CircuitBreakerState, reason: string, error?: unknown): void {
    const previousState = this.state;
    if (previousState === nextState) {
      return;
    }

    this.state = nextState;
    const timestamp = new Date(this.now()).toISOString();
    const errorMessage = error instanceof Error ? error.message : error ? String(error) : undefined;

    circuitBreakerState.set({ breaker: this.options.name, state: previousState }, 0);
    circuitBreakerState.set({ breaker: this.options.name, state: nextState }, 1);
    circuitBreakerStateChangesTotal.inc({
      breaker: this.options.name,
      from_state: previousState,
      to_state: nextState,
      reason,
    });

    logger.warn('Circuit breaker state changed', {
      breaker: this.options.name,
      previousState,
      state: nextState,
      reason,
      timestamp,
      failureCount: this.failureCount,
      nextAttemptAt: this.nextAttemptAtMs === null ? null : new Date(this.nextAttemptAtMs).toISOString(),
      error: errorMessage,
    });
  }
}
