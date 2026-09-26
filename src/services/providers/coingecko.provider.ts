import axios from 'axios';
import { Decimal } from '@prisma/client/runtime/library';
import { toDecimal } from '../../utils/decimal.util';
import {
  AssetPriceSet,
  PriceProvider,
  PriceProviderRateLimitError,
  parseRetryAfterMs,
} from '../price-provider.interface';

const DEFAULT_MULTI_ASSET_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,stellar&vs_currencies=usd';

export class CoinGeckoProvider implements PriceProvider {
  readonly name = 'coingecko';

  constructor(private readonly url: string, private readonly timeoutMs: number) {}

  /**
   * Normalize an axios failure: an HTTP 429 becomes a typed
   * {@link PriceProviderRateLimitError} carrying the parsed Retry-After so the
   * caller can back off instead of treating it like any other error.
   */
  private normalizeError(err: unknown): never {
    const response = (err as { response?: { status?: number; headers?: Record<string, unknown> } })
      ?.response;
    if (response?.status === 429) {
      throw new PriceProviderRateLimitError(
        this.name,
        parseRetryAfterMs(response.headers?.['retry-after']),
      );
    }
    throw err;
  }

  async fetchPrice(): Promise<Decimal> {
    let response: any;
    try {
      response = await axios.get(this.url, { timeout: this.timeoutMs });
    } catch (err) {
      this.normalizeError(err);
    }
    const rawPrice = response.data?.stellar?.usd;
    if (rawPrice === undefined || rawPrice === null) {
      throw new Error('Invalid response from CoinGecko: missing stellar.usd');
    }
    return toDecimal(rawPrice as string | number);
  }

  async fetchAssetPrices(): Promise<AssetPriceSet> {
    const multiAssetUrl = process.env.COINGECKO_MULTI_PRICE_URL ?? DEFAULT_MULTI_ASSET_URL;
    let response: any;
    try {
      response = await axios.get(multiAssetUrl, { timeout: this.timeoutMs });
    } catch (err) {
      this.normalizeError(err);
    }
    const data = response.data as Record<string, { usd?: number | string }> | undefined;

    const btc = data?.bitcoin?.usd;
    const eth = data?.ethereum?.usd;
    const xlm = data?.stellar?.usd;

    if (btc === undefined || btc === null || eth === undefined || eth === null || xlm === undefined || xlm === null) {
      throw new Error('Invalid response from CoinGecko: missing BTC, ETH, or XLM price');
    }

    return { BTC: toDecimal(btc), ETH: toDecimal(eth), XLM: toDecimal(xlm) };
  }
}
