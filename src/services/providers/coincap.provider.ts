import axios from 'axios';
import { Decimal } from '@prisma/client/runtime/library';
import { toDecimal } from '../../utils/decimal.util';
import { AssetPriceSet, PriceProvider } from '../price-provider.interface';

const DEFAULT_MULTI_ASSET_URL = 'https://api.coincap.io/v2/assets?ids=bitcoin,ethereum,stellar';
export const DEFAULT_COINCAP_TIMEOUT_MS = 5000;

interface CoinCapAsset {
  id: string;
  priceUsd?: string;
}

export class CoinCapProvider implements PriceProvider {
  readonly name = 'coincap';

  constructor(
    private readonly url: string,
    private readonly timeoutMs: number = DEFAULT_COINCAP_TIMEOUT_MS,
  ) {}

  private getEffectiveTimeout(): number {
    return typeof this.timeoutMs === 'number' && this.timeoutMs > 0
      ? this.timeoutMs
      : DEFAULT_COINCAP_TIMEOUT_MS;
  }

  async fetchPrice(): Promise<Decimal> {
    const timeout = this.getEffectiveTimeout();
    const response = await axios.get(this.url, { timeout });
    const rawPrice = response.data?.data?.priceUsd;
    if (rawPrice === undefined || rawPrice === null) {
      throw new Error('Invalid response from CoinCap: missing data.priceUsd');
    }
    return toDecimal(rawPrice as string | number);
  }

  async fetchAssetPrices(): Promise<AssetPriceSet> {
    const multiAssetUrl = process.env.COINCAP_MULTI_PRICE_URL ?? DEFAULT_MULTI_ASSET_URL;
    const timeout = this.getEffectiveTimeout();
    const response = await axios.get(multiAssetUrl, { timeout });
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
