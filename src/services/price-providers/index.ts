import { CoingeckoPriceProvider } from './coingecko.provider';
import { StaticPriceProvider } from './static.provider';
import { PriceFetchResult, PriceProvider, PriceProviderName } from './types';

const PROVIDER_FACTORIES: Record<
  PriceProviderName,
  () => PriceProvider
> = {
  coingecko: () => new CoingeckoPriceProvider(),
  static: () => new StaticPriceProvider(),
};

function parseProviderList(raw: string | undefined): PriceProviderName[] {
  if (!raw?.trim()) {
    return ['coingecko'];
  }

  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is PriceProviderName => entry in PROVIDER_FACTORIES);
}

export function resolvePriceProviders(): PriceProvider[] {
  const primary = (process.env.ORACLE_PROVIDER || 'coingecko').trim().toLowerCase();
  const fallbacks = parseProviderList(process.env.ORACLE_FALLBACK_PROVIDERS);

  const names = [
    primary as PriceProviderName,
    ...fallbacks.filter((name) => name !== primary),
  ].filter((name): name is PriceProviderName => name in PROVIDER_FACTORIES);

  const unique = [...new Set(names)];
  return unique.map((name) => PROVIDER_FACTORIES[name]());
}

export async function fetchPricesWithFailover(
  providers: PriceProvider[] = resolvePriceProviders(),
): Promise<PriceFetchResult> {
  let lastError: unknown;

  for (const provider of providers) {
    try {
      const result = await provider.fetchPrices();
      if (provider.name !== providers[0]?.name) {
        console.warn(
          `[price-oracle] failover engaged: primary=${providers[0]?.name} active=${provider.name}`,
        );
      }
      return result;
    } catch (error) {
      lastError = error;
      console.warn(
        `[price-oracle] provider failed: ${provider.name} — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('All configured price providers failed');
}
