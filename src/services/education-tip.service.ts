
import logger from "../utils/logger";
import { EducationalTip, TipContext } from "../types/education.types";
import { prisma } from "../lib/prisma";


/**
 * Tip template with interpolation support
 */
interface TipTemplate {
  id: string;
  message: string;
  category: "volatility" | "oracle" | "stellar" | "price-action";
  condition?: (context: TipContext) => boolean;
  priority?: number; // Higher = more likely to be selected
}

/**
 * Comprehensive library of educational tips
 * Organized by category with conditional logic
 */
const TIP_LIBRARY: TipTemplate[] = [
  // ===== PRICE ACTION TIPS (Always relevant) =====
  {
    id: "price-action-001",
    category: "price-action",
    message:
      "The price moved {priceChangePercent}% in this round. Price movements reflect the collective decisions of all market participants. Every trade is a vote on future value.",
    priority: 100,
  },
  {
    id: "price-action-002",
    category: "price-action",
    message:
      "The XLM price went {outcome} by ${priceChange}. Understanding price trends helps you identify market momentum. Consistent directional movement often indicates strong conviction from traders.",
    priority: 100,
  },
  {
    id: "price-action-003",
    category: "price-action",
    message:
      "This round lasted {duration} seconds. Shorter timeframes can show more erratic price movement, while longer timeframes tend to smooth out noise and reveal true trends.",
    priority: 90,
  },
  {
    id: "price-action-004",
    category: "price-action",
    message:
      "Price remained relatively {outcome} this round. Sideways or consolidating price action often precedes significant breakouts in either direction. Watch for volume changes.",
    priority: 80,
    condition: (ctx) => Math.abs(ctx.priceChangePercent) < 0.5,
  },

  // ===== VOLATILITY TIPS (High/low movement) =====
  {
    id: "volatility-001",
    category: "volatility",
    message:
      "This round showed high volatility with a {priceChangePercent}% change. Volatile markets offer opportunities but also increase risk. Consider reducing position sizes during high volatility periods.",
    priority: 120,
    condition: (ctx) => ctx.highVolatility,
  },
  {
    id: "volatility-002",
    category: "volatility",
    message:
      "The price moved {priceChangePercent}% - significant movement! Volatility can be measured using indicators like Bollinger Bands and ATR (Average True Range). These tools help quantify market uncertainty.",
    priority: 110,
    condition: (ctx) => Math.abs(ctx.priceChangePercent) > 2,
  },
  {
    id: "volatility-003",
    category: "volatility",
    message:
      "Low volatility detected with only a {priceChangePercent}% change. Low volatility periods often compress before explosive moves. Experienced traders watch for 'coiling' patterns that precede breakouts.",
    priority: 100,
    condition: (ctx) => Math.abs(ctx.priceChangePercent) < 0.5,
  },
  {
    id: "volatility-004",
    category: "volatility",
    message:
      "Market volatility affects risk-reward ratios. This {priceChangePercent}% move demonstrates how quickly prices can shift. Always set stop-losses and never risk more than you can afford to lose.",
    priority: 90,
    condition: (ctx) => Math.abs(ctx.priceChangePercent) > 1,
  },
  {
    id: "volatility-005",
    category: "volatility",
    message:
      "Extreme price movement of {priceChangePercent}%! When markets move rapidly, emotions can override logic. Successful traders stick to their plans and avoid FOMO (fear of missing out).",
    priority: 130,
    condition: (ctx) => Math.abs(ctx.priceChangePercent) > 5,
  },

  // ===== ORACLE TIPS (Data reliability) =====
  {
    id: "oracle-001",
    category: "oracle",
    message:
      "This round used oracle price data to determine the outcome. Oracles bridge real-world data to blockchain applications. They're essential for DeFi platforms to access accurate, tamper-resistant market prices.",
    priority: 80,
  },
  {
    id: "oracle-002",
    category: "oracle",
    message:
      "The final price of ${endPrice} was determined by our price oracle. Quality oracles aggregate data from multiple exchanges to prevent manipulation and ensure accuracy.",
    priority: 75,
  },
  {
    id: "oracle-003",
    category: "oracle",
    message:
      "Oracle reliability is critical for blockchain applications. This round's outcome was resolved using verified price feeds. Decentralized oracles reduce single points of failure.",
    priority: 70,
  },
  {
    id: "oracle-004",
    category: "oracle",
    message:
      "Price oracles update continuously to reflect market conditions. The {priceChangePercent}% change was captured by aggregating data from multiple sources for accuracy.",
    priority: 85,
    condition: (ctx) => Math.abs(ctx.priceChangePercent) > 1,
  },

  // ===== STELLAR NETWORK TIPS (Platform education) =====
  {
    id: "stellar-001",
    category: "stellar",
    message:
      "XLM (Lumens) is the native asset of the Stellar network. Stellar enables fast, low-cost cross-border payments with 3-5 second transaction finality - much faster than traditional systems.",
    priority: 70,
  },
  {
    id: "stellar-002",
    category: "stellar",
    message:
      "The Stellar network processes transactions for fractions of a cent. This round's {priceChangePercent}% price move affects XLM's value, but the network's utility remains consistent.",
    priority: 65,
  },
  {
    id: "stellar-003",
    category: "stellar",
    message:
      "Stellar uses the Stellar Consensus Protocol (SCP), which is energy-efficient unlike proof-of-work systems. SCP enables fast consensus without mining.",
    priority: 60,
  },
  {
    id: "stellar-004",
    category: "stellar",
    message:
      "This prediction market runs on blockchain technology similar to Stellar. The {outcome} outcome was recorded immutably, demonstrating blockchain's transparency.",
    priority: 75,
  },
  {
    id: "stellar-005",
    category: "stellar",
    message:
      "Stellar supports multiple assets and has a built-in decentralized exchange. This makes it ideal for applications requiring cross-asset swaps and price discovery.",
    priority: 70,
  },
];

/**
 * In-memory cache for generated tips
 * Key: roundId, Value: { tip, timestamp }
 */
interface CacheEntry {
  tip: EducationalTip;
  timestamp: number;
}

const tipCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Recently shown tip IDs to avoid repetition
 * Tracks last 10 tips shown across all rounds
 */
const recentTipIds: string[] = [];
const MAX_RECENT_TIPS = 10;

export class EducationTipService {
  /**
   * Generate an educational tip for a resolved round
   * @param roundId The ID of the round to generate a tip for
   * @returns Educational tip with message, category, and metadata
   */
  async generateTip(roundId: string): Promise<EducationalTip> {
    try {
      // Check cache first
      const cached = this.getCachedTip(roundId);
      if (cached) {
        logger.info("Educational tip served from cache", {
          roundId,
          category: cached.category,
        });
        return cached;
      }

      // Fetch round from database
      const round = await prisma.round.findUnique({
        where: { id: roundId },
        select: {
          id: true,
          mode: true,
          status: true,
          startPrice: true,
          endPrice: true,
          startTime: true,
          endTime: true,
        },
      });

      // Validate round exists
      if (!round) {
        throw new Error("Round not found");
      }

      // Validate round is resolved
      if (round.status !== "RESOLVED") {
        throw new Error(
          "Round must be resolved before generating educational tips",
        );
      }

      // Validate required data
      if (round.startPrice === null || round.endPrice === null) {
        throw new Error("Round missing required price data");
      }

      // Calculate context for tip selection
      const context = this.calculateContext(round);

      // Select appropriate tip based on context
      const tip = this.selectTip(context, roundId);

      // Cache the result
      this.cacheTip(roundId, tip);

      logger.info("Educational tip generated", {
        roundId,
        category: tip.category,
        priceChangePercent: context.priceChangePercent,
        cached: false,
      });

      return tip;
    } catch (error) {
      logger.error("Failed to generate educational tip", {
        roundId,
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * Calculate context metrics from round data
   * @param round Round data from database
   * @returns Context object with calculated metrics
   */
  private calculateContext(round: any): TipContext {
    const startPrice =
      typeof round.startPrice === "number"
        ? round.startPrice
        : parseFloat(round.startPrice.toString());
    const endPrice =
      typeof round.endPrice === "number"
        ? round.endPrice
        : parseFloat(round.endPrice.toString());

    const priceChange = endPrice - startPrice;
    const priceChangePercent = (priceChange / startPrice) * 100;

    const durationMs =
      new Date(round.endTime).getTime() - new Date(round.startTime).getTime();
    const duration = Math.floor(durationMs / 1000); // Convert to seconds

    let outcome: "up" | "down" | "unchanged";
    if (priceChange > 0) {
      outcome = "up";
    } else if (priceChange < 0) {
      outcome = "down";
    } else {
      outcome = "unchanged";
    }

    // High volatility if absolute percentage change > 2%
    const highVolatility = Math.abs(priceChangePercent) > 2;

    return {
      startPrice,
      endPrice,
      priceChange,
      priceChangePercent,
      duration,
      outcome,
      highVolatility,
      mode: round.mode,
    };
  }

  /**
   * Select an appropriate tip based on round context
   * @param context Calculated context metrics
   * @param roundId Round ID for metadata
   * @returns Educational tip with interpolated message
   */
  private selectTip(context: TipContext, roundId: string): EducationalTip {
    // Filter tips that match conditions
    const eligibleTips = TIP_LIBRARY.filter((template) => {
      if (template.condition) {
        return template.condition(context);
      }
      return true; // No condition = always eligible
    });

    // Remove recently shown tips to add variety
    const freshTips = eligibleTips.filter(
      (template) => !recentTipIds.includes(template.id),
    );

    // Use fresh tips if available, otherwise use all eligible
    const tipsToConsider = freshTips.length > 0 ? freshTips : eligibleTips;

    // Weighted random selection based on priority
    const selectedTemplate = this.weightedRandomSelection(tipsToConsider);

    // Track this tip to avoid repetition
    recentTipIds.push(selectedTemplate.id);
    if (recentTipIds.length > MAX_RECENT_TIPS) {
      recentTipIds.shift(); // Remove oldest
    }

    // Interpolate variables into message
    const message = this.interpolateMessage(selectedTemplate.message, context);

    return {
      message,
      category: selectedTemplate.category,
      roundId,
      metadata: {
        priceChange: parseFloat(context.priceChange.toFixed(4)),
        priceChangePercent: parseFloat(context.priceChangePercent.toFixed(2)),
        duration: context.duration,
        outcome: context.outcome,
      },
    };
  }

  /**
   * Weighted random selection from tips based on priority
   * @param tips Array of tip templates
   * @returns Selected tip template
   */
  private weightedRandomSelection(tips: TipTemplate[]): TipTemplate {
    // Calculate total weight
    const totalWeight = tips.reduce(
      (sum, tip) => sum + (tip.priority || 50),
      0,
    );

    // Random number between 0 and totalWeight
    let random = Math.random() * totalWeight;

    // Select tip based on weight
    for (const tip of tips) {
      random -= tip.priority || 50;
      if (random <= 0) {
        return tip;
      }
    }

    // Fallback (should never reach here)
    return tips[0];
  }

  /**
   * Interpolate context variables into message template
   * @param template Message template with {variable} placeholders
   * @param context Context with values to interpolate
   * @returns Interpolated message
   */
  private interpolateMessage(template: string, context: TipContext): string {
    return template
      .replace(
        /{priceChangePercent}/g,
        Math.abs(context.priceChangePercent).toFixed(2),
      )
      .replace(/{priceChange}/g, Math.abs(context.priceChange).toFixed(4))
      .replace(/{outcome}/g, context.outcome)
      .replace(/{duration}/g, context.duration.toString())
      .replace(/{startPrice}/g, context.startPrice.toFixed(4))
      .replace(/{endPrice}/g, context.endPrice.toFixed(4));
  }

  /**
   * Get tip from cache if available and not expired
   * @param roundId Round ID to lookup
   * @returns Cached tip or null
   */
  private getCachedTip(roundId: string): EducationalTip | null {
    const cached = tipCache.get(roundId);
    if (!cached) {
      return null;
    }

    // Check if expired
    const now = Date.now();
    if (now - cached.timestamp > CACHE_TTL_MS) {
      tipCache.delete(roundId);
      return null;
    }

    return cached.tip;
  }

  /**
   * Cache a generated tip
   * @param roundId Round ID
   * @param tip Generated tip
   */
  private cacheTip(roundId: string, tip: EducationalTip): void {
    tipCache.set(roundId, {
      tip,
      timestamp: Date.now(),
    });

    // Prevent memory leaks - limit cache size
    if (tipCache.size > 1000) {
      // Remove oldest entries
      const sortedEntries = Array.from(tipCache.entries()).sort(
        (a, b) => a[1].timestamp - b[1].timestamp,
      );
      const toRemove = sortedEntries.slice(0, 200); // Remove oldest 200
      toRemove.forEach(([key]) => tipCache.delete(key));

      logger.info("Tip cache pruned", {
        removedCount: toRemove.length,
        remainingCount: tipCache.size,
      });
    }
  }

  /**
   * Clear cache for a specific round (useful if round data is corrected)
   * @param roundId Round ID to clear
   */
  clearCache(roundId: string): void {
    tipCache.delete(roundId);
    logger.info("Tip cache cleared for round", { roundId });
  }

  /**
   * Get cache statistics
   * @returns Cache stats object
   */
  getCacheStats(): { size: number; maxSize: number; ttlMs: number } {
    return {
      size: tipCache.size,
      maxSize: 1000,
      ttlMs: CACHE_TTL_MS,
    };
  }
}

export default new EducationTipService();
