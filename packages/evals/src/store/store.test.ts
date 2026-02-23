import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, it } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { RunStore } from '@deepagents/evals/store';
import type { CaseData, RunSummary, ScoreData } from '@deepagents/evals/store';

function makeCases(runId: string, count: number): CaseData[] {
  return Array.from({ length: count }, (_, i) => ({
    id: crypto.randomUUID(),
    run_id: runId,
    idx: i,
    input: { question: `q${i}` },
    output: `answer-${i}`,
    expected: `expected-${i}`,
    latency_ms: 100 + i * 10,
    tokens_in: 50 + i,
    tokens_out: 30 + i,
  }));
}

function makeScores(
  caseId: string,
  scorers: Array<{ name: string; score: number; reason?: string }>,
): ScoreData[] {
  return scorers.map((s) => ({
    id: crypto.randomUUID(),
    case_id: caseId,
    scorer_name: s.name,
    score: s.score,
    reason: s.reason,
  }));
}

function createRunInSuite(
  store: RunStore,
  run: { name: string; model: string; config?: Record<string, unknown> },
): { suiteId: string; runId: string } {
  const suite = store.createSuite(`suite-${crypto.randomUUID()}`);
  const runId = store.createRun({
    suite_id: suite.id,
    name: run.name,
    model: run.model,
    config: run.config,
  });
  return { suiteId: suite.id, runId };
}

describe('RunStore', () => {
  let store: RunStore;

  beforeEach(() => {
    store = new RunStore(new DatabaseSync(':memory:'));
  });

  it('creates a suite and returns id and name', () => {
    const suite = store.createSuite('accuracy-suite');

    assert.ok(suite.id, 'suite should have an id');
    assert.strictEqual(suite.name, 'accuracy-suite');
    assert.ok(
      suite.created_at > 0,
      'created_at should be a positive timestamp',
    );
  });

  it('creates a run linked to a suite and lists it', () => {
    const suite = store.createSuite('linked-suite');
    const runId = store.createRun({
      suite_id: suite.id,
      name: 'run-1',
      model: 'gpt-4',
      config: { temperature: 0.7 },
    });

    const runs = store.listRuns(suite.id);

    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].id, runId);
    assert.strictEqual(runs[0].suite_id, suite.id);
    assert.strictEqual(runs[0].name, 'run-1');
    assert.strictEqual(runs[0].model, 'gpt-4');
    assert.deepStrictEqual(runs[0].config, { temperature: 0.7 });
    assert.strictEqual(runs[0].status, 'running');
  });

  it('creates a run and retrieves it via getRun', () => {
    const { suiteId, runId } = createRunInSuite(store, {
      name: 'run-with-suite',
      model: 'claude-3',
    });

    const run = store.getRun(runId);

    assert.ok(run, 'run should exist');
    assert.strictEqual(run.id, runId);
    assert.strictEqual(run.suite_id, suiteId);
    assert.strictEqual(run.name, 'run-with-suite');
    assert.strictEqual(run.model, 'claude-3');
    assert.strictEqual(run.config, null);
    assert.strictEqual(run.status, 'running');
    assert.strictEqual(run.finished_at, null);
    assert.strictEqual(run.summary, null);
  });

  it('saves cases in batch and retrieves them in idx order', () => {
    const { runId } = createRunInSuite(store, {
      name: 'batch-run',
      model: 'gpt-4',
    });
    const cases = makeCases(runId, 5);

    store.saveCases(cases);
    const retrieved = store.getCases(runId);

    assert.strictEqual(retrieved.length, 5);
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(retrieved[i].idx, i);
      assert.strictEqual(retrieved[i].id, cases[i].id);
      assert.deepStrictEqual(retrieved[i].input, { question: `q${i}` });
      assert.strictEqual(retrieved[i].output, `answer-${i}`);
    }
  });

  it('getFailingCases returns cases with scores below threshold', () => {
    const { runId } = createRunInSuite(store, {
      name: 'failing-run',
      model: 'gpt-4',
    });
    const cases = makeCases(runId, 3);
    store.saveCases(cases);

    const scores: ScoreData[] = [
      ...makeScores(cases[0].id, [{ name: 'accuracy', score: 0.9 }]),
      ...makeScores(cases[1].id, [
        { name: 'accuracy', score: 0.3, reason: 'wrong answer' },
      ]),
      ...makeScores(cases[2].id, [{ name: 'accuracy', score: 0.1 }]),
    ];
    store.saveScores(scores);

    const failing = store.getFailingCases(runId, 0.5);

    assert.strictEqual(failing.length, 2);
    const failingIds = failing.map((c) => c.id);
    assert.ok(failingIds.includes(cases[1].id));
    assert.ok(failingIds.includes(cases[2].id));

    const case1 = failing.find((c) => c.id === cases[1].id)!;
    assert.strictEqual(case1.scores.length, 1);
    assert.strictEqual(case1.scores[0].scorer_name, 'accuracy');
    assert.strictEqual(case1.scores[0].score, 0.3);
    assert.strictEqual(case1.scores[0].reason, 'wrong answer');
  });

  it('getRunSummary computes correct aggregates', () => {
    const { runId } = createRunInSuite(store, {
      name: 'summary-run',
      model: 'gpt-4',
    });
    const cases = makeCases(runId, 4);
    store.saveCases(cases);

    const scores: ScoreData[] = [
      ...makeScores(cases[0].id, [{ name: 'accuracy', score: 0.8 }]),
      ...makeScores(cases[1].id, [{ name: 'accuracy', score: 0.6 }]),
      ...makeScores(cases[2].id, [{ name: 'accuracy', score: 0.3 }]),
      ...makeScores(cases[3].id, [{ name: 'accuracy', score: 0.9 }]),
    ];
    store.saveScores(scores);

    const summary = store.getRunSummary(runId, 0.5);

    assert.strictEqual(summary.totalCases, 4);
    assert.strictEqual(summary.passCount, 3);
    assert.strictEqual(summary.failCount, 1);

    const expectedMean = (0.8 + 0.6 + 0.3 + 0.9) / 4;
    assert.ok(
      Math.abs(summary.meanScores['accuracy'] - expectedMean) < 0.001,
      `mean accuracy should be ~${expectedMean}, got ${summary.meanScores['accuracy']}`,
    );

    const expectedLatency = cases.reduce((sum, c) => sum + c.latency_ms, 0);
    assert.strictEqual(summary.totalLatencyMs, expectedLatency);

    const expectedTokensIn = cases.reduce((sum, c) => sum + c.tokens_in, 0);
    assert.strictEqual(summary.totalTokensIn, expectedTokensIn);

    const expectedTokensOut = cases.reduce((sum, c) => sum + c.tokens_out, 0);
    assert.strictEqual(summary.totalTokensOut, expectedTokensOut);
  });

  it('listSuites returns suites in descending creation order', async () => {
    store.createSuite('first');
    await setTimeout(5);
    store.createSuite('second');
    await setTimeout(5);
    store.createSuite('third');

    const suites = store.listSuites();

    assert.strictEqual(suites.length, 3);
    assert.strictEqual(suites[0].name, 'third');
    assert.strictEqual(suites[1].name, 'second');
    assert.strictEqual(suites[2].name, 'first');

    assert.ok(suites[0].created_at > suites[1].created_at);
    assert.ok(suites[1].created_at > suites[2].created_at);
  });

  it('finishRun updates status and summary', () => {
    const { runId } = createRunInSuite(store, {
      name: 'finish-run',
      model: 'gpt-4',
    });

    const summary: RunSummary = {
      totalCases: 10,
      passCount: 8,
      failCount: 2,
      meanScores: { accuracy: 0.85, relevance: 0.72 },
      totalLatencyMs: 5000,
      totalTokensIn: 2000,
      totalTokensOut: 1500,
    };

    store.finishRun(runId, 'completed', summary);

    const run = store.getRun(runId)!;
    assert.strictEqual(run.status, 'completed');
    assert.ok(run.finished_at !== null, 'finished_at should be set');
    assert.ok(run.finished_at! >= run.started_at, 'finished_at >= started_at');
    assert.deepStrictEqual(run.summary, summary);
  });

  it('creates a prompt and lists it', () => {
    const prompt = store.createPrompt(
      'test-prompt',
      'You are a test assistant',
    );

    assert.ok(prompt.id);
    assert.strictEqual(prompt.name, 'test-prompt');
    assert.strictEqual(prompt.version, 1);
    assert.strictEqual(prompt.content, 'You are a test assistant');
    assert.ok(prompt.created_at > 0);

    const prompts = store.listPrompts();
    assert.strictEqual(prompts.length, 1);
    assert.strictEqual(prompts[0].id, prompt.id);
  });

  it('getPrompt returns undefined for missing id', () => {
    assert.strictEqual(store.getPrompt('nonexistent'), undefined);
  });

  it('deletePrompt removes the prompt', () => {
    const prompt = store.createPrompt('to-delete', 'content');
    store.deletePrompt(prompt.id);
    assert.strictEqual(store.getPrompt(prompt.id), undefined);
    assert.strictEqual(store.listPrompts().length, 0);
  });

  it('saving the same prompt name creates a new version', () => {
    const v1 = store.createPrompt('unique-name', 'content 1');
    const v2 = store.createPrompt('unique-name', 'content 2');

    assert.strictEqual(v1.version, 1);
    assert.strictEqual(v2.version, 2);

    const prompts = store.listPrompts().filter((p) => p.name === 'unique-name');
    assert.strictEqual(prompts.length, 2);
    assert.strictEqual(prompts[0].version, 2);
    assert.strictEqual(prompts[1].version, 1);
  });

  it('migrates legacy prompts table and preserves prompt data', () => {
    const db = new DatabaseSync(':memory:');
    const legacyPromptId = crypto.randomUUID();
    db.exec(`
      CREATE TABLE prompts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      'INSERT INTO prompts (id, name, content, created_at) VALUES (?, ?, ?, ?)',
    ).run(legacyPromptId, 'legacy-prompt', 'legacy content', Date.now());

    const migratedStore = new RunStore(db);
    const legacyPrompt = migratedStore.getPrompt(legacyPromptId);

    assert.ok(legacyPrompt);
    assert.strictEqual(legacyPrompt!.name, 'legacy-prompt');
    assert.strictEqual(legacyPrompt!.version, 1);
    assert.strictEqual(legacyPrompt!.content, 'legacy content');

    const v2 = migratedStore.createPrompt('legacy-prompt', 'updated content');
    assert.strictEqual(v2.version, 2);
  });

  it('migrates runs to require suite_id and drops orphaned runs', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE suites (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        suite_id TEXT,
        name TEXT NOT NULL,
        model TEXT NOT NULL,
        config TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed')),
        summary TEXT,
        FOREIGN KEY (suite_id) REFERENCES suites(id) ON DELETE SET NULL
      );
      CREATE INDEX idx_runs_suite_id ON runs(suite_id);
      CREATE INDEX idx_runs_started_at ON runs(started_at);
    `);

    const suiteId = crypto.randomUUID();
    db.prepare(
      'INSERT INTO suites (id, name, created_at) VALUES (?, ?, ?)',
    ).run(suiteId, 'legacy-suite', Date.now());

    const validRunId = crypto.randomUUID();
    db.prepare(
      'INSERT INTO runs (id, suite_id, name, model, started_at, status) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(validRunId, suiteId, 'valid-run', 'gpt-4', Date.now(), 'running');

    db.prepare(
      'INSERT INTO runs (id, suite_id, name, model, started_at, status) VALUES (?, NULL, ?, ?, ?, ?)',
    ).run(crypto.randomUUID(), 'orphan-run', 'gpt-4', Date.now(), 'running');

    const migratedStore = new RunStore(db);
    const suiteColumn = (
      db.prepare('PRAGMA table_info(runs)').all() as Array<{
        name: string;
        notnull: number;
      }>
    ).find((column) => column.name === 'suite_id');
    assert.strictEqual(suiteColumn?.notnull, 1);

    const suiteForeignKey = (
      db.prepare('PRAGMA foreign_key_list(runs)').all() as Array<{
        from: string;
        on_delete: string;
        table: string;
      }>
    ).find((fk) => fk.from === 'suite_id' && fk.table === 'suites');
    assert.strictEqual(suiteForeignKey?.on_delete, 'CASCADE');

    const runs = migratedStore.listRuns();
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].id, validRunId);
    assert.strictEqual(runs[0].suite_id, suiteId);

    assert.throws(
      () =>
        db
          .prepare(
            'INSERT INTO runs (id, suite_id, name, model, started_at, status) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            crypto.randomUUID(),
            null,
            'should-fail',
            'gpt-4',
            Date.now(),
            'running',
          ),
      /NOT NULL/i,
    );

    db.prepare('DELETE FROM suites WHERE id = ?').run(suiteId);
    assert.strictEqual(migratedStore.listRuns().length, 0);
  });

  it('saves multiple scorers per case and retrieves all scores', () => {
    const { runId } = createRunInSuite(store, {
      name: 'multi-scorer-run',
      model: 'gpt-4',
    });
    const cases = makeCases(runId, 2);
    store.saveCases(cases);

    const scores: ScoreData[] = [
      ...makeScores(cases[0].id, [
        { name: 'accuracy', score: 0.2, reason: 'wrong' },
        { name: 'relevance', score: 0.1, reason: 'off-topic' },
        { name: 'fluency', score: 0.95 },
      ]),
      ...makeScores(cases[1].id, [
        { name: 'accuracy', score: 0.85 },
        { name: 'relevance', score: 0.4 },
      ]),
    ];
    store.saveScores(scores);

    const failing = store.getFailingCases(runId, 0.5);

    const case0 = failing.find((c) => c.id === cases[0].id)!;
    assert.ok(case0, 'case 0 should be in failing results');
    assert.strictEqual(case0.scores.length, 2);
    const scorerNames0 = case0.scores.map((s) => s.scorer_name).sort();
    assert.deepStrictEqual(scorerNames0, ['accuracy', 'relevance']);

    const case1 = failing.find((c) => c.id === cases[1].id)!;
    assert.ok(case1, 'case 1 should be in failing results');
    assert.strictEqual(case1.scores.length, 1);
    assert.strictEqual(case1.scores[0].scorer_name, 'relevance');
    assert.strictEqual(case1.scores[0].score, 0.4);

    const summary = store.getRunSummary(runId, 0.5);
    assert.ok('accuracy' in summary.meanScores);
    assert.ok('relevance' in summary.meanScores);
    assert.ok('fluency' in summary.meanScores);

    const expectedAccuracy = (0.2 + 0.85) / 2;
    assert.ok(
      Math.abs(summary.meanScores['accuracy'] - expectedAccuracy) < 0.001,
    );

    const expectedRelevance = (0.1 + 0.4) / 2;
    assert.ok(
      Math.abs(summary.meanScores['relevance'] - expectedRelevance) < 0.001,
    );
  });
});
