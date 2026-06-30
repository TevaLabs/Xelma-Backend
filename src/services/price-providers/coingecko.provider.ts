import { AssetPrices } from './types';
import { PriceFetchResult, PriceProvider } from './types';

const DEFAULT_COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,stellar&vs_currencies=usd';

function getCoingeckoUrl(): string {
  return process.env.COINGECKO_API_URL?.trim() || DEFAULT_COINGECKO_URL;
}

function mapCoingeckoResponse(data: unknown): AssetPrices {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid CoinGecko response');
  }

  const payload = data as Record<string, { usd?: number } | undefined>;
  const btc = payload.bitcoin?.usd;
  const eth = payload.ethereum?.usd;
  const xlm = payload.stellar?.usd;

  if (
    typeof btc !== 'number' ||
    typeof eth !== 'number' ||
    typeof xlm !== 'number'
  ) {
    throw new Error('CoinGecko response missing BTC, ETH, or XLM prices');
  }

  return { BTC: btc, ETH: eth, XLM: xlm };
}

export class CoingeckoPriceProvider implements PriceProvider {
  readonly name = 'coingecko' as const;

  async fetchPrices(): Promise<PriceFetchResult> {
    const response = await fetch(getCoingeckoUrl(), {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`CoinGecko request failed with status ${response.status}`);
    }

    const data = await response.json();
    return {
      prices: mapCoingeckoResponse(data),
      fetchedAt: new Date(),
      source: this.name,
    };
  }
}

/** Exported for oracle unit tests that mock axios/fetch against CoinGecko payloads. */
export function mapCoingeckoPricePayload(data: unknown): AssetPrices {
  return mapCoingeckoResponse(data);
}
