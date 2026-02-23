import type { CaseWithScores, RunStore, RunSummary } from '../store/index.ts';

export type ChangeType = 'improved' | 'regressed' | 'unchanged';

export interface CaseDiff {
  index: number;
  scorerDeltas: Record<
    string,
    { baseline: number; candidate: number; delta: number; change: ChangeType }
  >;
}

export interface ScorerSummary {
  meanDelta: number;
  improvedCount: number;
  regressedCount: number;
  unchangedCount: number;
}

export interface CostDelta {
  latencyDeltaMs: number;
  tokenInDelta: number;
  tokenOutDelta: number;
}

export interface ComparisonResult {
  caseDiffs: CaseDiff[];
  scorerSummaries: Record<string, ScorerSummary>;
  costDelta: CostDelta;
  totalCasesCompared: number;
  regression: {
    regressed: boolean;
    details: Record<string, { meanDelta: number; exceeds: boolean }>;
  };
}

export interface CompareOptions {
  tolerance?: number;
  regressionThreshold?: number;
}

function categorize(delta: number, tolerance: number): ChangeType {
  if (Math.abs(delta) <= tolerance) return 'unchanged';
  return delta > 0 ? 'improved' : 'regressed';
}

function buildScoreMap(
  cases: CaseWithScores[],
): Map<number, Record<string, number>> {
  const map = new Map<number, Record<string, number>>();
  for (const c of cases) {
    const scores: Record<string, number> = {};
    for (const s of c.scores) {
      scores[s.scorer_name] = s.score;
    }
    map.set(c.idx, scores);
  }
  return map;
}

function getAllCasesWithScores(
  store: RunStore,
  runId: string,
): CaseWithScores[] {
  const cases = store.getCases(runId);
  const withScores = store.getFailingCases(runId, Infinity);
  const scoredMap = new Map(withScores.map((c) => [c.id, c]));
  return cases.map((c) => scoredMap.get(c.id) ?? { ...c, scores: [] });
}

export function compareRuns(
  store: RunStore,
  baselineRunId: string,
  candidateRunId: string,
  options?: CompareOptions,
): ComparisonResult {
  const tolerance = options?.tolerance ?? 0.01;
  const regressionThreshold = options?.regressionThreshold ?? 0.05;

  const baselineCases = getAllCasesWithScores(store, baselineRunId);
  const candidateCases = getAllCasesWithScores(store, candidateRunId);

  if (baselineCases.length !== candidateCases.length) {
    console.warn(
      `Run case count mismatch: baseline=${baselineCases.length}, candidate=${candidateCases.length}. Comparing intersection only.`,
    );
  }

  const baselineMap = buildScoreMap(baselineCases);
  const candidateMap = buildScoreMap(candidateCases);

  const allScorerNames = new Set<string>();
  for (const scores of baselineMap.values()) {
    for (const name of Object.keys(scores)) allScorerNames.add(name);
  }
  for (const scores of candidateMap.values()) {
    for (const name of Object.keys(scores)) allScorerNames.add(name);
  }

  const commonIndices = [...baselineMap.keys()].filter((idx) =>
    candidateMap.has(idx),
  );
  commonIndices.sort((a, b) => a - b);

  const caseDiffs: CaseDiff[] = [];
  const scorerDeltas: Record<string, number[]> = {};
  const scorerCounts: Record<
    string,
    { improved: number; regressed: number; unchanged: number }
  > = {};

  for (const name of allScorerNames) {
    scorerDeltas[name] = [];
    scorerCounts[name] = { improved: 0, regressed: 0, unchanged: 0 };
  }

  for (const idx of commonIndices) {
    const baseScores = baselineMap.get(idx)!;
    const candScores = candidateMap.get(idx)!;
    const diff: CaseDiff = { index: idx, scorerDeltas: {} };

    for (const name of allScorerNames) {
      const baseline = baseScores[name] ?? 0;
      const candidate = candScores[name] ?? 0;
      const delta = candidate - baseline;
      const change = categorize(delta, tolerance);

      diff.scorerDeltas[name] = { baseline, candidate, delta, change };
      scorerDeltas[name]!.push(delta);

      if (change === 'improved') scorerCounts[name]!.improved++;
      else if (change === 'regressed') scorerCounts[name]!.regressed++;
      else scorerCounts[name]!.unchanged++;
    }

    caseDiffs.push(diff);
  }

  const scorerSummaries: Record<string, ScorerSummary> = {};
  for (const name of allScorerNames) {
    const deltas = scorerDeltas[name]!;
    const meanDelta =
      deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
    scorerSummaries[name] = {
      meanDelta,
      improvedCount: scorerCounts[name]!.improved,
      regressedCount: scorerCounts[name]!.regressed,
      unchangedCount: scorerCounts[name]!.unchanged,
    };
  }

  const baselineSummary = store.getRunSummary(baselineRunId);
  const candidateSummary = store.getRunSummary(candidateRunId);

  const costDelta: CostDelta = {
    latencyDeltaMs:
      candidateSummary.totalLatencyMs - baselineSummary.totalLatencyMs,
    tokenInDelta:
      candidateSummary.totalTokensIn - baselineSummary.totalTokensIn,
    tokenOutDelta:
      candidateSummary.totalTokensOut - baselineSummary.totalTokensOut,
  };

  const regressionDetails: Record<
    string,
    { meanDelta: number; exceeds: boolean }
  > = {};
  let anyRegressed = false;
  for (const [name, summary] of Object.entries(scorerSummaries)) {
    const exceeds = summary.meanDelta < -regressionThreshold;
    regressionDetails[name] = { meanDelta: summary.meanDelta, exceeds };
    if (exceeds) anyRegressed = true;
  }

  return {
    caseDiffs,
    scorerSummaries,
    costDelta,
    totalCasesCompared: commonIndices.length,
    regression: { regressed: anyRegressed, details: regressionDetails },
  };
}
