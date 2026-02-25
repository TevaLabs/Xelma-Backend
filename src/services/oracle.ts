import axios from 'axios';
import logger from '../utils/logger';

class PriceOracle {
  private static instance: PriceOracle;
  private price: number | null = null;
  private readonly COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd';
  private readonly POLLING_INTERVAL = 10000; // 10 seconds
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private _running = false;

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
    try {
      const response = await axios.get(this.COINGECKO_URL);
      if (response.data && response.data.stellar && response.data.stellar.usd) {
        this.price = response.data.stellar.usd;
        logger.info(`Fetched XLM price: $${this.price}`);
      } else {
        logger.warn('Invalid response structure from CoinGecko:', response.data);
      }
    } catch (error: any) {
      logger.error('Error fetching XLM price:', error.message);
      // Just log the error. Price remains old value if it exists, or null.
    }
  }

  public getPrice(): number | null {
    return this.price;
  }
}

export default PriceOracle.getInstance();
