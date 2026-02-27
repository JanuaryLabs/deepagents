export type RunSummary = {
  failCount: number;
  meanScores: { [key: string]: number };
  passCount: number;
  totalCases: number;
  totalLatencyMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
};
