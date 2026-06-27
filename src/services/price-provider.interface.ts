import { Decimal } from '@prisma/client/runtime/library';

export interface PriceProvider {
  readonly name: string;
  fetchPrice(): Promise<Decimal>;
}
