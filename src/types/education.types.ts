export interface EducationGuide {
  id: string;
  title: string;
  content: string;
  category: "volatility" | "stellar" | "oracles";
  createdAt: string;
  updatedAt: string;
}

export interface EducationGuidesResponse {
  guides: EducationGuide[];
  categories: {
    volatility: EducationGuide[];
    stellar: EducationGuide[];
    oracles: EducationGuide[];
  };
  total: number;
}
export interface EducationalTip {
  message: string;
  category: "volatility" | "oracle" | "stellar" | "price-action";
  roundId: string;
  metadata?: {
    priceChange?: number;
    priceChangePercent?: number;
    duration?: number;
    outcome?: string;
  };
}
export interface TipContext {
  startPrice: number ;
  endPrice: number;
  priceChange: number;
  priceChangePercent: number;
  duration: number; // in seconds
  outcome: "up" | "down" | "unchanged";
  highVolatility: boolean;
  mode:  "UP_DOWN" | "LEGENDS"
}

export interface EducationalTipResponse {
  message: string;
  category: "volatility" | "oracle" | "stellar" | "price-action";
  roundId: string;
  metadata: {
    priceChange: number;
    priceChangePercent: number;
    duration: number;
    outcome: string;
  };
}
