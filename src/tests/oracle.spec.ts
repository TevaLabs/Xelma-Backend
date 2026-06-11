import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import axios from 'axios';
import { Decimal } from '@prisma/client/runtime/library';
import priceOracle from '../services/oracle';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('PriceOracle', () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    (priceOracle as any).price = null;
    (priceOracle as any).lastUpdatedAt = null;
    (priceOracle as any).breaker.reset();
  });

  it('stores fetched prices as Decimal and preserves exact string precision', async () => {
    mockedAxios.get.mockResolvedValue({
      data: { stellar: { usd: '0.12345678' } },
    });

    await (priceOracle as any).fetchPrice();

    expect(priceOracle.getPrice()).toBeInstanceOf(Decimal);
    expect(priceOracle.getPriceString()).toBe('0.12345678');
    expect(priceOracle.getPriceNumber()).toBeCloseTo(0.12345678);
  });

  it('exposes null when fetch fails and does not set price', async () => {
    mockedAxios.get.mockRejectedValue(new Error('network error'));

    await (priceOracle as any).fetchPrice();

    expect(priceOracle.getPrice()).toBeNull();
    expect(priceOracle.getPriceString()).toBeNull();
  });
});
