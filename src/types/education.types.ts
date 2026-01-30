export interface EducationGuide {
  id: string;
  title: string;
  content: string;
  category: 'volatility' | 'stellar' | 'oracles';
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
