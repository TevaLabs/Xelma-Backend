import { Router, Request, Response } from "express";
import {
  EducationGuidesResponse,
  EducationGuide,
  EducationalTipResponse,
} from "../types/education.types";
import educationTipService from "../services/education-tip.service";
import logger from "../utils/logger";

const router = Router();

/**
 * @swagger
 * /api/education/guides:
 *   get:
 *     summary: Get educational guides
 *     description: Returns a structured list of static educational guides grouped by category.
 *     tags: [education]
 *     responses:
 *       200:
 *         description: Education guides
 *         content:
 *           application/json:
 *             example:
 *               guides: []
 *               categories:
 *                 volatility: []
 *                 stellar: []
 *                 oracles: []
 *               total: 0
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             example:
 *               error: Internal Server Error
 *               message: Failed to fetch education guides
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X GET "$API_BASE_URL/api/education/guides"
 */

/**
 * Static educational content
 * This structure is designed to be easily extensible for future CMS or admin tooling
 */
const educationGuides: EducationGuide[] = [
  // Volatility Category
  {
    id: "volatility-001",
    title: "Understanding Market Volatility",
    content:
      "Market volatility refers to the rate at which the price of an asset increases or decreases over a given period. High volatility means prices can change dramatically in a short time, while low volatility indicates more stable prices. Understanding volatility is crucial for risk management and making informed trading decisions.",
    category: "volatility",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "volatility-002",
    title: "Risk Management Strategies",
    content:
      "Effective risk management is essential when trading volatile assets. Key strategies include: setting stop-loss orders to limit potential losses, diversifying your portfolio across different assets, never investing more than you can afford to lose, and using position sizing to control exposure. Remember, volatility can work both for and against you.",
    category: "volatility",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "volatility-003",
    title: "Reading Price Charts",
    content:
      "Price charts are visual representations of an asset's price movement over time. Common chart types include line charts, candlestick charts, and bar charts. Candlestick charts are particularly useful as they show open, high, low, and close prices. Learning to read charts helps identify trends, support and resistance levels, and potential entry/exit points.",
    category: "volatility",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "volatility-004",
    title: "Market Psychology and Emotions",
    content:
      "Trading psychology plays a crucial role in success. Common emotional pitfalls include fear of missing out (FOMO), panic selling during downturns, and greed that prevents taking profits. Develop a trading plan and stick to it, regardless of emotions. Practice discipline and patience, as emotional decisions often lead to losses.",
    category: "volatility",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "volatility-005",
    title: "Volatility Indicators",
    content:
      "Technical indicators help measure and predict volatility. Popular indicators include: Bollinger Bands (show price volatility and potential reversal points), Average True Range (ATR) which measures market volatility, and the Volatility Index (VIX) for market sentiment. Understanding these tools can help you make more informed trading decisions.",
    category: "volatility",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },

  // Stellar Category
  {
    id: "stellar-001",
    title: "Introduction to Stellar",
    content:
      "Stellar is an open-source blockchain network designed to facilitate fast, low-cost cross-border payments and asset transfers. Founded in 2014, Stellar aims to connect financial institutions, payment systems, and people. The native asset of the Stellar network is called Lumens (XLM), which is used to pay transaction fees and maintain accounts.",
    category: "stellar",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "stellar-002",
    title: "Stellar Consensus Protocol (SCP)",
    content:
      "Stellar uses a unique consensus mechanism called the Stellar Consensus Protocol (SCP), which is based on Federated Byzantine Agreement (FBA). Unlike proof-of-work systems, SCP is energy-efficient and allows for fast transaction confirmation (typically 3-5 seconds). The protocol enables decentralized control while maintaining security and efficiency.",
    category: "stellar",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "stellar-003",
    title: "Stellar Accounts and Wallets",
    content:
      'A Stellar account is identified by a public key (starting with "G") and requires a minimum balance of 1 XLM to exist. Each account has a secret key (starting with "S") that must be kept secure. Wallets store these keys and allow you to send/receive XLM and other assets. Always use reputable wallet software and never share your secret key.',
    category: "stellar",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "stellar-004",
    title: "Stellar Assets and Anchors",
    content:
      'Stellar can represent any currency or asset, not just XLM. These are called "assets" and are issued by entities called "anchors." Anchors are trusted entities that hold deposits and issue credits on the Stellar network. This allows for seamless conversion between different currencies and assets, making Stellar ideal for remittances and cross-border payments.',
    category: "stellar",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "stellar-005",
    title: "Stellar Network Features",
    content:
      "Key features of the Stellar network include: fast transactions (3-5 second confirmation), low fees (typically 0.00001 XLM per transaction), multi-asset support, built-in decentralized exchange (DEX), and path payments that automatically find the best exchange rate. These features make Stellar an excellent choice for financial applications.",
    category: "stellar",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "stellar-006",
    title: "Stellar Development and SDKs",
    content:
      "Stellar provides comprehensive developer tools including SDKs for JavaScript, Python, Java, Go, and more. The Stellar Laboratory offers a web-based interface for testing transactions and exploring the network. Developers can build applications for payments, remittances, asset tokenization, and decentralized exchanges using Stellar's robust infrastructure.",
    category: "stellar",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },

  // Oracles Category
  {
    id: "oracles-001",
    title: "What Are Oracles?",
    content:
      "Oracles are services that provide external data to blockchain applications. Since blockchains are isolated systems, they cannot directly access real-world data like prices, weather, or sports scores. Oracles act as bridges, fetching data from external sources and making it available on-chain. This enables smart contracts to react to real-world events and data.",
    category: "oracles",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "oracles-002",
    title: "Price Oracles Explained",
    content:
      "Price oracles are specialized oracles that provide cryptocurrency and asset price data to blockchain applications. They aggregate price information from multiple exchanges and data sources to provide accurate, up-to-date pricing. Price oracles are essential for DeFi applications like lending protocols, decentralized exchanges, and derivatives platforms that need reliable price feeds.",
    category: "oracles",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "oracles-003",
    title: "How Oracles Work",
    content:
      "Oracles typically work in several steps: 1) Data collection from external sources (APIs, websites, sensors), 2) Data validation and aggregation from multiple sources, 3) Formatting data for blockchain consumption, 4) Signing and broadcasting data to the blockchain, 5) Smart contracts reading and using the data. Some oracles use multiple nodes to ensure data accuracy and prevent manipulation.",
    category: "oracles",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "oracles-004",
    title: "Oracle Security and Trust",
    content:
      "Oracle security is critical because incorrect data can lead to significant financial losses. Common security measures include: using multiple independent data sources, implementing reputation systems for oracle providers, requiring economic stakes (bonding) from oracle operators, using cryptographic proofs, and implementing time-weighted average prices (TWAP) to reduce manipulation risk.",
    category: "oracles",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "oracles-005",
    title: "Types of Oracles",
    content:
      "Oracles come in different types: Software oracles fetch data from online sources (APIs, websites), Hardware oracles collect data from physical devices (sensors, IoT), Inbound oracles bring external data to the blockchain, Outbound oracles send blockchain data to external systems, Centralized oracles rely on a single source (faster but less secure), and Decentralized oracles use multiple sources (more secure but slower).",
    category: "oracles",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "oracles-006",
    title: "Oracle Use Cases",
    content:
      "Oracles enable numerous blockchain applications: DeFi protocols use price oracles for lending, borrowing, and trading, Insurance contracts can trigger payouts based on real-world events, Supply chain tracking uses IoT oracles to monitor goods, Prediction markets rely on oracles for outcome resolution, and Gaming applications use oracles for random number generation and external events.",
    category: "oracles",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
];

/**
 * GET /api/education/guides
 * Returns a structured list of educational guides and tips
 * Content is grouped by category (volatility, Stellar, oracles)
 */
router.get("/guides", (req: Request, res: Response) => {
  try {
    // Group guides by category
    const categories = {
      volatility: educationGuides.filter(
        (guide) => guide.category === "volatility",
      ),
      stellar: educationGuides.filter((guide) => guide.category === "stellar"),
      oracles: educationGuides.filter((guide) => guide.category === "oracles"),
    };

    const response: EducationGuidesResponse = {
      guides: educationGuides,
      categories,
      total: educationGuides.length,
    };

    return res.status(200).json(response);
  } catch (error) {
    logger.error("Error fetching education guides:", { error });
    return res.status(500).json({
      error: "Internal Server Error",
      message: "Failed to fetch education guides",
    });
  }
});
/**
 * GET /api/education/tip
 * Generate contextual educational tip for a resolved round
 *
 * Query Parameters:
 *   - roundId (required): UUID of the resolved round
 *
 * Response:
 *   {
 *     "message": "Educational message tailored to round outcome",
 *     "category": "volatility | oracle | stellar | price-action",
 *     "roundId": "uuid",
 *     "metadata": {
 *       "priceChange": 0.04,
 *       "priceChangePercent": 3.2,
 *       "duration": 300,
 *       "outcome": "up | down | unchanged"
 *     }
 *   }
 *
 * Error Responses:
 *   - 400: Missing or invalid roundId
 *   - 404: Round not found
 *   - 422: Round not resolved yet
 *   - 500: Internal server error
 */
router.get("/tip", async (req: Request, res: Response) => {
  try {
    const { roundId } = req.query;

    // Validate roundId parameter
    if (!roundId) {
      return res.status(400).json({
        error: "Validation Error",
        message: "roundId query parameter is required",
      });
    }

    if (typeof roundId !== "string") {
      return res.status(400).json({
        error: "Validation Error",
        message: "roundId must be a string",
      });
    }

    // UUID format validation (basic)
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(roundId)) {
      return res.status(400).json({
        error: "Validation Error",
        message: "roundId must be a valid UUID",
      });
    }

    // Generate tip using service
    const tip = await educationTipService.generateTip(roundId);

    // Format response
    const response: EducationalTipResponse = {
      message: tip.message,
      category: tip.category,
      roundId: tip.roundId,
      metadata: {
        priceChange: tip.metadata?.priceChange || 0,
        priceChangePercent: tip.metadata?.priceChangePercent || 0,
        duration: tip.metadata?.duration || 0,
        outcome: tip.metadata?.outcome || "unchanged",
      },
    };

    return res.status(200).json(response);
  } catch (error: any) {
    logger.error("Failed to generate educational tip", {
      roundId: req.query.roundId,
      error: error.message,
      stack: error.stack,
    });

    // Handle specific error types
    if (error.message === "Round not found") {
      return res.status(404).json({
        error: "Not Found",
        message: "Round not found",
      });
    }

    if (
      error.message ===
      "Round must be resolved before generating educational tips"
    ) {
      return res.status(422).json({
        error: "Invalid Round State",
        message: "Round must be resolved before generating educational tips",
      });
    }

    if (error.message === "Round missing required price data") {
      return res.status(422).json({
        error: "Invalid Round Data",
        message: "Round is missing required price data",
      });
    }

    // Generic error
    return res.status(500).json({
      error: "Internal Server Error",
      message: "Failed to generate educational tip",
    });
  }
});

export default router;
