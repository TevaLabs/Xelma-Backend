import logger from '../utils/logger';
import { toNumber, toDecimalString } from '../utils/decimal.util';
import { TimeoutResult, withTimeout } from '../utils/timeout-wrapper';
import { CircuitBreaker, CircuitBreakerOpenError } from '../utils/circuit-breaker';
import { Decimal } from '@prisma/client/runtime/library';
import config from '../config';
import {
  priceOracleFetchFailuresTotal,
  priceOracleUpdatesTotal,
} from '../metrics/application.metrics';
import { PriceProvider } from './price-provider.interface';
import { CoinGeckoProvider } from './providers/coingecko.provider';
import { CoinCapProvider } from './providers/coincap.provider';

interface ProviderEntry {
  provider: PriceProvider;
  breaker: CircuitBreaker;
}

class PriceOracle {
  private static instance: PriceOracle;
  private price: Decimal | null = null;
  private lastProvider: string | null = null;
  private readonly POLLING_INTERVAL = config.oracle.pollingIntervalMs;
  private readonly REQUEST_TIMEOUT = config.oracle.requestTimeoutMs;
  private readonly MAX_RETRIES = config.oracle.maxRetries;
  private readonly STALENESS_THRESHOLD = config.oracle.stalenessThresholdMs;
  private readonly providerChain: ProviderEntry[];
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private lastUpdatedAt: Date | null = null;

  private constructor() {
    this.providerChain = [
      {
        provider: new CoinGeckoProvider(config.oracle.coinGeckoUrl, this.REQUEST_TIMEOUT),
        breaker: new CircuitBreaker({
          name: 'coingecko-price-oracle',
          failureThreshold: 3,
          openBackoffMs: 30_000,
        }),
      },
      {
        provider: new CoinCapProvider(config.oracle.coinCapUrl, this.REQUEST_TIMEOUT),
        breaker: new CircuitBreaker({
          name: 'coincap-price-oracle',
          failureThreshold: 3,
          openBackoffMs: 30_000,
        }),
      },
    ];
  }

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
    this.fetchPrice();
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

  private async tryProvider(entry: ProviderEntry): Promise<TimeoutResult<Decimal>> {
    const { provider, breaker } = entry;

    try {
      const result = await breaker.execute(async () => {
        const timeoutResult = await withTimeout(
          () => provider.fetchPrice(),
          {
            timeoutMs: this.REQUEST_TIMEOUT,
            operationName: `fetchPriceFrom:${provider.name}`,
            retries: this.MAX_RETRIES,
          }
        );

        if (!timeoutResult.success) {
          throw timeoutResult.error ?? new Error(`Failed to fetch price from ${provider.name}`);
        }

        return timeoutResult;
      });

      return result;
    } catch (error) {
      if (error instanceof CircuitBreakerOpenError) {
        logger.warn(`Skipped ${provider.name} price fetch — circuit breaker is open`, {
          breaker: error.breakerName,
          nextAttemptAt: error.nextAttemptAt.toISOString(),
        });
        return {
          success: false,
          error: new Error(`Circuit breaker open for ${provider.name}`),
          durationMs: 0,
          retriesUsed: 0,
          timedOut: false,
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        durationMs: 0,
        retriesUsed: 0,
        timedOut: error instanceof Error && error.message.includes('timeout'),
      };
    }
  }

  private async fetchPrice(): Promise<void> {
    for (const entry of this.providerChain) {
      const result = await this.tryProvider(entry);

      if (result.success && result.data) {
        this.price = result.data;
        this.lastProvider = entry.provider.name;
        this.lastUpdatedAt = new Date();
        priceOracleUpdatesTotal.inc({ provider: entry.provider.name });
        logger.info(`Fetched XLM price: $${toDecimalString(result.data)} via ${entry.provider.name}`, {
          provider: entry.provider.name,
          durationMs: result.durationMs,
          retriesUsed: result.retriesUsed,
        });
        return;
      }

      priceOracleFetchFailuresTotal.inc({
        reason: result.timedOut ? 'timeout' : 'upstream_error',
        provider: entry.provider.name,
      });
      logger.warn(`Price fetch failed for provider ${entry.provider.name}, trying next`, {
        provider: entry.provider.name,
        error: result.error?.message,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
      });
    }

    logger.error('All price providers failed — price not updated', {
      providers: this.providerChain.map(e => e.provider.name),
    });
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

  public getLastProvider(): string | null {
    return this.lastProvider;
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
