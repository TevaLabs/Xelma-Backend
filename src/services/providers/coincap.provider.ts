import axios from 'axios';
import { Decimal } from '@prisma/client/runtime/library';
import { toDecimal } from '../../utils/decimal.util';
import { PriceProvider } from '../price-provider.interface';

export class CoinCapProvider implements PriceProvider {
  readonly name = 'coincap';

  constructor(private readonly url: string, private readonly timeoutMs: number) {}

  async fetchPrice(): Promise<Decimal> {
    const response = await axios.get(this.url, { timeout: this.timeoutMs });
    const rawPrice = response.data?.data?.priceUsd;
    if (rawPrice === undefined || rawPrice === null) {
      throw new Error('Invalid response from CoinCap: missing data.priceUsd');
    }
    return toDecimal(rawPrice as string | number);
  }
}
