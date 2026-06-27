import { PriceFetchResult, PriceProvider } from './types';

/**
 * Deterministic fallback provider for failover drills and offline demos.
 * Values are intentionally static — not suitable for production settlement.
 */
export class StaticPriceProvider implements PriceProvider {
  readonly name = 'static' as const;

  async fetchPrices(): Promise<PriceFetchResult> {
    return {
      prices: { BTC: 67000, ETH: 3200, XLM: 0.28 },
      fetchedAt: new Date(),
      source: this.name,
    };
  }
}
