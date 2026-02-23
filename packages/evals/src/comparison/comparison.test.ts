import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, it } from 'node:test';

import { compareRuns } from '@deepagents/evals/comparison';
import { RunStore } from '@deepagents/evals/store';
import type { CaseData, ScoreData } from '@deepagents/evals/store';

function populateRun(
  store: RunStore,
  runId: string,
  cases: Array<{ idx: number; scores: Record<string, number> }>,
  overrides?: { latency_ms?: number; tokens_in?: number; tokens_out?: number },
) {
  const caseDataList: CaseData[] = cases.map((c) => ({
    id: crypto.randomUUID(),
    run_id: runId,
    idx: c.idx,
    input: { question: `q${c.idx}` },
    output: `answer${c.idx}`,
    latency_ms: overrides?.latency_ms ?? 100,
    tokens_in: overrides?.tokens_in ?? 50,
    tokens_out: overrides?.tokens_out ?? 25,
  }));
  store.saveCases(caseDataList);

  for (let i = 0; i < caseDataList.length; i++) {
    const scoreData: ScoreData[] = Object.entries(cases[i].scores).map(
      ([name, score]) => ({
        id: crypto.randomUUID(),
        case_id: caseDataList[i].id,
        scorer_name: name,
        score,
      }),
    );
    store.saveScores(scoreData);
  }
}

function createRunInSuite(
  store: RunStore,
  name: string,
  model: string,
): string {
  const suite = store.createSuite(`suite-${crypto.randomUUID()}`);
  return store.createRun({ suite_id: suite.id, name, model });
}

describe('compareRuns', () => {
  let store: RunStore;

  beforeEach(() => {
    store = new RunStore(new DatabaseSync(':memory:'));
  });

  it('reports all cases as unchanged when runs have identical scores', () => {
    const baselineId = createRunInSuite(store, 'baseline', 'gpt-4');
    const candidateId = createRunInSuite(store, 'candidate', 'gpt-4');

    const sharedCases = [
      { idx: 0, scores: { accuracy: 0.8, relevance: 0.7 } },
      { idx: 1, scores: { accuracy: 0.9, relevance: 0.6 } },
      { idx: 2, scores: { accuracy: 0.75, relevance: 0.85 } },
    ];
    populateRun(store, baselineId, sharedCases);
    populateRun(store, candidateId, sharedCases);

    const result = compareRuns(store, baselineId, candidateId);

    assert.strictEqual(result.totalCasesCompared, 3);
    assert.strictEqual(result.regression.regressed, false);

    for (const diff of result.caseDiffs) {
      for (const [, detail] of Object.entries(diff.scorerDeltas)) {
        assert.strictEqual(detail.change, 'unchanged');
        assert.strictEqual(detail.delta, 0);
      }
    }

    for (const [, summary] of Object.entries(result.scorerSummaries)) {
      assert.strictEqual(summary.improvedCount, 0);
      assert.strictEqual(summary.regressedCount, 0);
      assert.strictEqual(summary.unchangedCount, 3);
      assert.strictEqual(summary.meanDelta, 0);
    }
  });

  it('detects improvement when candidate scores higher than baseline', () => {
    const baselineId = createRunInSuite(store, 'baseline', 'gpt-4');
    const candidateId = createRunInSuite(store, 'candidate', 'gpt-4');

    populateRun(store, baselineId, [
      { idx: 0, scores: { accuracy: 0.5 } },
      { idx: 1, scores: { accuracy: 0.4 } },
    ]);
    populateRun(store, candidateId, [
      { idx: 0, scores: { accuracy: 0.9 } },
      { idx: 1, scores: { accuracy: 0.8 } },
    ]);

    const result = compareRuns(store, baselineId, candidateId);

    assert.strictEqual(result.totalCasesCompared, 2);
    assert.strictEqual(result.regression.regressed, false);

    for (const diff of result.caseDiffs) {
      assert.strictEqual(diff.scorerDeltas['accuracy'].change, 'improved');
      assert.ok(diff.scorerDeltas['accuracy'].delta > 0);
    }

    const summary = result.scorerSummaries['accuracy'];
    assert.strictEqual(summary.improvedCount, 2);
    assert.strictEqual(summary.regressedCount, 0);
    assert.strictEqual(summary.unchangedCount, 0);
    assert.ok(summary.meanDelta > 0);
  });

  it('detects regression when candidate scores lower and flags it', () => {
    const baselineId = createRunInSuite(store, 'baseline', 'gpt-4');
    const candidateId = createRunInSuite(store, 'candidate', 'gpt-4');

    populateRun(store, baselineId, [
      { idx: 0, scores: { accuracy: 0.9 } },
      { idx: 1, scores: { accuracy: 0.8 } },
    ]);
    populateRun(store, candidateId, [
      { idx: 0, scores: { accuracy: 0.3 } },
      { idx: 1, scores: { accuracy: 0.2 } },
    ]);

    const result = compareRuns(store, baselineId, candidateId);

    assert.strictEqual(result.totalCasesCompared, 2);
    assert.strictEqual(result.regression.regressed, true);

    for (const diff of result.caseDiffs) {
      assert.strictEqual(diff.scorerDeltas['accuracy'].change, 'regressed');
      assert.ok(diff.scorerDeltas['accuracy'].delta < 0);
    }

    const summary = result.scorerSummaries['accuracy'];
    assert.strictEqual(summary.improvedCount, 0);
    assert.strictEqual(summary.regressedCount, 2);
    assert.strictEqual(summary.unchangedCount, 0);
    assert.ok(summary.meanDelta < -0.05);

    assert.strictEqual(result.regression.details['accuracy'].exceeds, true);
    assert.ok(result.regression.details['accuracy'].meanDelta < 0);
  });

  it('handles mixed results with improved, regressed, and unchanged cases', () => {
    const baselineId = createRunInSuite(store, 'baseline', 'gpt-4');
    const candidateId = createRunInSuite(store, 'candidate', 'gpt-4');

    populateRun(store, baselineId, [
      { idx: 0, scores: { accuracy: 0.5 } },
      { idx: 1, scores: { accuracy: 0.8 } },
      { idx: 2, scores: { accuracy: 0.6 } },
    ]);
    populateRun(store, candidateId, [
      { idx: 0, scores: { accuracy: 0.9 } },
      { idx: 1, scores: { accuracy: 0.3 } },
      { idx: 2, scores: { accuracy: 0.6 } },
    ]);

    const result = compareRuns(store, baselineId, candidateId);

    assert.strictEqual(result.totalCasesCompared, 3);

    const case0 = result.caseDiffs.find((d) => d.index === 0)!;
    assert.strictEqual(case0.scorerDeltas['accuracy'].change, 'improved');

    const case1 = result.caseDiffs.find((d) => d.index === 1)!;
    assert.strictEqual(case1.scorerDeltas['accuracy'].change, 'regressed');

    const case2 = result.caseDiffs.find((d) => d.index === 2)!;
    assert.strictEqual(case2.scorerDeltas['accuracy'].change, 'unchanged');

    const summary = result.scorerSummaries['accuracy'];
    assert.strictEqual(summary.improvedCount, 1);
    assert.strictEqual(summary.regressedCount, 1);
    assert.strictEqual(summary.unchangedCount, 1);
  });

  it('computes correct cost and token deltas between runs', () => {
    const baselineId = createRunInSuite(store, 'baseline', 'gpt-4');
    const candidateId = createRunInSuite(store, 'candidate', 'gpt-4');

    populateRun(
      store,
      baselineId,
      [
        { idx: 0, scores: { accuracy: 0.8 } },
        { idx: 1, scores: { accuracy: 0.7 } },
      ],
      { latency_ms: 200, tokens_in: 100, tokens_out: 50 },
    );
    populateRun(
      store,
      candidateId,
      [
        { idx: 0, scores: { accuracy: 0.8 } },
        { idx: 1, scores: { accuracy: 0.7 } },
      ],
      { latency_ms: 300, tokens_in: 150, tokens_out: 80 },
    );

    const result = compareRuns(store, baselineId, candidateId);

    assert.strictEqual(result.costDelta.latencyDeltaMs, 200);
    assert.strictEqual(result.costDelta.tokenInDelta, 100);
    assert.strictEqual(result.costDelta.tokenOutDelta, 60);
  });

  it('treats delta at tolerance boundary as unchanged and beyond as changed', () => {
    const baselineId = createRunInSuite(store, 'baseline', 'gpt-4');
    const candidateId = createRunInSuite(store, 'candidate', 'gpt-4');

    populateRun(store, baselineId, [
      { idx: 0, scores: { accuracy: 0.5 } },
      { idx: 1, scores: { accuracy: 0.5 } },
      { idx: 2, scores: { accuracy: 0.5 } },
    ]);
    populateRun(store, candidateId, [
      { idx: 0, scores: { accuracy: 0.625 } },
      { idx: 1, scores: { accuracy: 0.75 } },
      { idx: 2, scores: { accuracy: 0.25 } },
    ]);

    const result = compareRuns(store, baselineId, candidateId, {
      tolerance: 0.125,
    });

    const atTolerance = result.caseDiffs.find((d) => d.index === 0)!;
    assert.strictEqual(
      atTolerance.scorerDeltas['accuracy'].change,
      'unchanged',
      'delta of 0.125 (== tolerance) should be unchanged',
    );

    const aboveTolerance = result.caseDiffs.find((d) => d.index === 1)!;
    assert.strictEqual(
      aboveTolerance.scorerDeltas['accuracy'].change,
      'improved',
      'delta of 0.25 (> tolerance) should be improved',
    );

    const belowTolerance = result.caseDiffs.find((d) => d.index === 2)!;
    assert.strictEqual(
      belowTolerance.scorerDeltas['accuracy'].change,
      'regressed',
      'delta of -0.25 (> tolerance in magnitude) should be regressed',
    );
  });
});
