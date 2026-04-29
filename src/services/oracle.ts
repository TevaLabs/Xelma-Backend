import axios from 'axios';
import logger from '../utils/logger';
import { toDecimal, toNumber, toDecimalString } from '../utils/decimal.util';
import { TimeoutResult, withTimeout } from '../utils/timeout-wrapper';
import { CircuitBreaker, CircuitBreakerOpenError } from '../utils/circuit-breaker';
import { Decimal } from '@prisma/client/runtime/library';
import config from '../config';

class PriceOracle {
  private static instance: PriceOracle;
  private price: Decimal | null = null;
  private readonly COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd';
  private readonly POLLING_INTERVAL = config.oracle.pollingIntervalMs;
  private readonly REQUEST_TIMEOUT = config.oracle.requestTimeoutMs;
  private readonly MAX_RETRIES = config.oracle.maxRetries;
  private readonly STALENESS_THRESHOLD = config.oracle.stalenessThresholdMs;
  private readonly breaker = new CircuitBreaker({
    name: 'coingecko-price-oracle',
    failureThreshold: 3,
    openBackoffMs: 30_000,
  });
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private lastUpdatedAt: Date | null = null;

  private constructor() {}

  public static getInstance(): PriceOracle {
    if (!PriceOracle.instance) {
      PriceOracle.instance = new PriceOracle();
    }
    return PriceOracle.instance;
  }

  public startPolling(): void {
    if (this._running) {
      logger.warn('Price Oracle polling already running — ignoring duplicate start');
      return;
    }
    this._running = true;

    // Initial fetch
    this.fetchPrice();

    // Start polling interval
    this.pollingInterval = setInterval(() => {
      this.fetchPrice();
    }, this.POLLING_INTERVAL);

    logger.info('Price Oracle polling started');
  }

  public stopPolling(): void {
    if (!this._running) {
      return;
    }
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this._running = false;
    logger.info('Price Oracle polling stopped');
  }

  public isRunning(): boolean {
    return this._running;
  }

  private async fetchPrice(): Promise<void> {
    let result: TimeoutResult<Decimal>;

    try {
      result = await this.breaker.execute(async () => {
        const timeoutResult = await withTimeout(
          async () => {
            const response = await axios.get(this.COINGECKO_URL, {
              timeout: this.REQUEST_TIMEOUT,
            });
            const rawPrice = response.data?.stellar?.usd;
            if (rawPrice !== undefined && rawPrice !== null) {
              return toDecimal(rawPrice as string | number);
            } else {
              throw new Error('Invalid response structure from CoinGecko: missing stellar.usd');
            }
          },
          {
            timeoutMs: this.REQUEST_TIMEOUT,
            operationName: 'fetchPriceFromCoinGecko',
            retries: this.MAX_RETRIES,
          }
        );

        if (!timeoutResult.success) {
          throw timeoutResult.error ?? new Error('Failed to fetch price from CoinGecko');
        }

        return timeoutResult;
      });
    } catch (error) {
      if (error instanceof CircuitBreakerOpenError) {
        logger.warn('Skipped CoinGecko price fetch because circuit breaker is open', {
          breaker: error.breakerName,
          nextAttemptAt: error.nextAttemptAt.toISOString(),
        });
        return;
      }

      result = {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        durationMs: 0,
        retriesUsed: 0,
        timedOut: error instanceof Error && error.message.includes('timeout'),
      };
    }

    if (result.success && result.data) {
      const fetchedPrice = result.data;
      this.price = fetchedPrice;
      this.lastUpdatedAt = new Date();
      logger.info(`Fetched XLM price: $${toDecimalString(fetchedPrice)}`, {
        durationMs: result.durationMs,
        retriesUsed: result.retriesUsed,
      });
    } else {
      logger.error(
        'Failed to fetch price from CoinGecko after retries',
        {
          error: result.error?.message,
          durationMs: result.durationMs,
          retriesUsed: result.retriesUsed,
          timedOut: result.timedOut,
        }
      );
    }
  }

  public getPrice(): Decimal | null {
    return this.price;
  }

  public getPriceNumber(): number | null {
    return this.price ? toNumber(this.price) : null;
  }

  public getPriceString(places = 8): string | null {
    return this.price ? toDecimalString(this.price, places) : null;
  }

  public isStale(): boolean {
    if (!this.lastUpdatedAt) return true;
    return Date.now() - this.lastUpdatedAt.getTime() > this.STALENESS_THRESHOLD;
  }

  public getLastUpdatedAt(): Date | null {
    return this.lastUpdatedAt;
  }
}

export default PriceOracle.getInstance();
