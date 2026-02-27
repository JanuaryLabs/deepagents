import type * as models from '../index.ts';

export type ComparisonResult = {
  caseDiffs: models.CaseDiff[];
  costDelta: models.CostDelta;
  regression: {
    details: { exceeds: boolean; meanDelta: number };
    regressed: boolean;
  };
  scorerSummaries: { [key: string]: models.ScorerSummary };
  totalCasesCompared: number;
};
