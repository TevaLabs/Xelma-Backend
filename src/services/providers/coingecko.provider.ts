import axios from 'axios';
import { Decimal } from '@prisma/client/runtime/library';
import { toDecimal } from '../../utils/decimal.util';
import { PriceProvider } from '../price-provider.interface';

export class CoinGeckoProvider implements PriceProvider {
  readonly name = 'coingecko';

  constructor(private readonly url: string, private readonly timeoutMs: number) {}

  async fetchPrice(): Promise<Decimal> {
    const response = await axios.get(this.url, { timeout: this.timeoutMs });
    const rawPrice = response.data?.stellar?.usd;
    if (rawPrice === undefined || rawPrice === null) {
      throw new Error('Invalid response from CoinGecko: missing stellar.usd');
    }
    return toDecimal(rawPrice as string | number);
  }
}
