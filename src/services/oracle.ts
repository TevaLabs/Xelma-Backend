import axios from 'axios';
import logger from '../utils/logger';
import { toDecimal, toNumber, toDecimalString } from '../utils/decimal.util';
import { withTimeout } from '../utils/timeout-wrapper';
import { Decimal } from '@prisma/client/runtime/library';

class PriceOracle {
  private static instance: PriceOracle;
  private price: Decimal | null = null;
  private readonly COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd';
  private readonly POLLING_INTERVAL = 10000; // 10 seconds
  private readonly REQUEST_TIMEOUT = 5000; // 5s timeout
  private readonly MAX_RETRIES = 3;
  private readonly STALENESS_THRESHOLD = 60000; // 60s
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
    const result = await withTimeout(
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

    if (result.success && result.data) {
      this.price = result.data;
      this.lastUpdatedAt = new Date();
      logger.info(`Fetched XLM price: $${toDecimalString(this.price)}`, {
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
