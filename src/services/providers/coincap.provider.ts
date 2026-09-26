import axios from 'axios';
import { Decimal } from '@prisma/client/runtime/library';
import { toDecimal } from '../../utils/decimal.util';
import {
  AssetPriceSet,
  PriceProvider,
  PriceProviderRateLimitError,
  parseRetryAfterMs,
} from '../price-provider.interface';

const DEFAULT_MULTI_ASSET_URL = 'https://api.coincap.io/v2/assets?ids=bitcoin,ethereum,stellar';

interface CoinCapAsset {
  id: string;
  priceUsd?: string;
}

export class CoinCapProvider implements PriceProvider {
  readonly name = 'coincap';

  constructor(private readonly url: string, private readonly timeoutMs: number) {}

  /** Normalize an HTTP 429 into a typed rate-limit error; rethrow otherwise. */
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
    const rawPrice = response.data?.data?.priceUsd;
    if (rawPrice === undefined || rawPrice === null) {
      throw new Error('Invalid response from CoinCap: missing data.priceUsd');
    }
    return toDecimal(rawPrice as string | number);
  }

  async fetchAssetPrices(): Promise<AssetPriceSet> {
    const multiAssetUrl = process.env.COINCAP_MULTI_PRICE_URL ?? DEFAULT_MULTI_ASSET_URL;
    let response: any;
    try {
      response = await axios.get(multiAssetUrl, { timeout: this.timeoutMs });
    } catch (err) {
      this.normalizeError(err);
    }
    const assets = (response.data?.data ?? []) as CoinCapAsset[];
    const byId = new Map(assets.map((asset) => [asset.id, asset.priceUsd]));

    const btc = byId.get('bitcoin');
    const eth = byId.get('ethereum');
    const xlm = byId.get('stellar');

    if (btc === undefined || btc === null || eth === undefined || eth === null || xlm === undefined || xlm === null) {
      throw new Error('Invalid response from CoinCap: missing BTC, ETH, or XLM price');
    }

    return { BTC: toDecimal(btc), ETH: toDecimal(eth), XLM: toDecimal(xlm) };
  }
}
