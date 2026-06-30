export type AssetPrices = {
  BTC: number;
  ETH: number;
  XLM: number;
};

export type PriceProviderName = 'coingecko' | 'static';

export interface PriceFetchResult {
  prices: AssetPrices;
  fetchedAt: Date;
  source: PriceProviderName;
}

export interface PriceProvider {
  readonly name: PriceProviderName;
  fetchPrices(): Promise<PriceFetchResult>;
}
