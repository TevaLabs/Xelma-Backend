import axios from 'axios';
import logger from '../utils/logger';

class PriceOracle {
  private static instance: PriceOracle;
  private price: number | null = null;
  private readonly COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd';
  private readonly POLLING_INTERVAL = 10000; // 10 seconds
  private readonly REQUEST_TIMEOUT = 5000; // 5s axios timeout
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

  private async fetchPrice(attempt = 1): Promise<void> {
    try {
      const response = await axios.get(this.COINGECKO_URL, {
        timeout: this.REQUEST_TIMEOUT,
      });
      if (response.data?.stellar?.usd) {
        this.price = response.data.stellar.usd;
        this.lastUpdatedAt = new Date();
        logger.info(`Fetched XLM price: $${this.price}`);
      } else {
        logger.warn('Invalid response structure from CoinGecko:', response.data);
      }
    } catch (error: any) {
      if (attempt < this.MAX_RETRIES) {
        const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
        logger.warn(
          `Price fetch attempt ${attempt} failed, retrying in ${backoffMs}ms: ${error.message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        return this.fetchPrice(attempt + 1);
      }
      logger.error(`Price fetch failed after ${this.MAX_RETRIES} attempts: ${error.message}`);
    }
  }

  public getPrice(): number | null {
    return this.price;
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
