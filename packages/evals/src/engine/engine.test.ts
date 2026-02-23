import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { dataset } from '@deepagents/evals/dataset';
import { EvalEmitter, runEval } from '@deepagents/evals/engine';
import { exactMatch } from '@deepagents/evals/scorers';
import { RunStore } from '@deepagents/evals/store';

interface Item {
  input: string;
  expected: string;
}

const echoTask = async (item: Item) => ({
  output: item.expected,
  usage: { inputTokens: 10, outputTokens: 5 },
});

describe('runEval', () => {
  it('basic run with 3 items computes correct summary', async () => {
    const store = new RunStore(new DatabaseSync(':memory:'));
    const ds = dataset<Item>([
      { input: 'What is 1+1?', expected: '2' },
      { input: 'What is 2+2?', expected: '4' },
      { input: 'What is 3+3?', expected: '6' },
    ]);

    const summary = await runEval({
      name: 'basic-test',
      model: 'test-model',
      dataset: ds,
      task: echoTask,
      scorers: { exact: exactMatch },
      store,
    });

    assert.strictEqual(summary.totalCases, 3);
    assert.strictEqual(summary.passCount, 3);
    assert.strictEqual(summary.failCount, 0);
    assert.strictEqual(summary.meanScores['exact'], 1.0);
    assert.strictEqual(summary.totalTokensIn, 30);
    assert.strictEqual(summary.totalTokensOut, 15);
  });

  it('task error continues execution and records score 0', async () => {
    const store = new RunStore(new DatabaseSync(':memory:'));
    const emitter = new EvalEmitter();
    const errors: Array<{ index: number; error: string }> = [];
    emitter.on('case:error', (data) => errors.push(data));

    const ds = dataset<Item>([
      { input: 'ok-1', expected: 'ok-1' },
      { input: 'fail', expected: 'fail' },
      { input: 'ok-2', expected: 'ok-2' },
    ]);

    const failingTask = async (item: Item) => {
      if (item.input === 'fail') {
        throw new Error('intentional failure');
      }
      return {
        output: item.expected,
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    };

    const summary = await runEval({
      name: 'error-test',
      model: 'test-model',
      dataset: ds,
      task: failingTask,
      scorers: { exact: exactMatch },
      store,
      emitter,
      maxConcurrency: 1,
    });

    assert.strictEqual(summary.totalCases, 3);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].index, 1);
    assert.match(errors[0].error, /intentional failure/);
    assert.strictEqual(summary.passCount, 2);
    assert.strictEqual(summary.failCount, 1);
  });

  it('concurrency limit is respected', async () => {
    const store = new RunStore(new DatabaseSync(':memory:'));
    let active = 0;
    let maxActive = 0;

    const items = Array.from({ length: 6 }, (_, i) => ({
      input: `q${i}`,
      expected: `a${i}`,
    }));

    const slowTask = async (item: Item) => {
      active++;
      if (active > maxActive) maxActive = active;
      await setTimeout(30);
      active--;
      return {
        output: item.expected,
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    };

    await runEval({
      name: 'concurrency-test',
      model: 'test-model',
      dataset: dataset<Item>(items),
      task: slowTask,
      scorers: { exact: exactMatch },
      store,
      maxConcurrency: 2,
    });

    assert.ok(maxActive <= 2, `max concurrent was ${maxActive}, expected <= 2`);
    assert.ok(
      maxActive >= 2,
      `max concurrent was ${maxActive}, expected to reach 2`,
    );
  });

  it('timeout records case as error with timeout exceeded message', async () => {
    const store = new RunStore(new DatabaseSync(':memory:'));
    const emitter = new EvalEmitter();
    const errors: Array<{ index: number; error: string }> = [];
    emitter.on('case:error', (data) => errors.push(data));

    const ds = dataset<Item>([{ input: 'slow', expected: 'slow' }]);

    const hangingTask = async (_item: Item) => {
      await setTimeout(500);
      return {
        output: 'should not reach',
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    };

    const summary = await runEval({
      name: 'timeout-test',
      model: 'test-model',
      dataset: ds,
      task: hangingTask,
      scorers: { exact: exactMatch },
      store,
      emitter,
      timeout: 50,
    });

    assert.strictEqual(summary.totalCases, 1);
    assert.strictEqual(summary.failCount, 1);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].error, /timeout exceeded/);
  });

  it('events are emitted in correct order with maxConcurrency=1', async () => {
    const store = new RunStore(new DatabaseSync(':memory:'));
    const emitter = new EvalEmitter();
    const events: string[] = [];

    emitter.on('run:start', () => events.push('run:start'));
    emitter.on('case:start', (d) => events.push(`case:start(${d.index})`));
    emitter.on('case:scored', (d) => events.push(`case:scored(${d.index})`));
    emitter.on('run:end', () => events.push('run:end'));

    const ds = dataset<Item>([
      { input: 'a', expected: 'a' },
      { input: 'b', expected: 'b' },
    ]);

    await runEval({
      name: 'event-order-test',
      model: 'test-model',
      dataset: ds,
      task: echoTask,
      scorers: { exact: exactMatch },
      store,
      emitter,
      maxConcurrency: 1,
    });

    assert.deepStrictEqual(events, [
      'run:start',
      'case:start(0)',
      'case:scored(0)',
      'case:start(1)',
      'case:scored(1)',
      'run:end',
    ]);
  });

  it('store persistence: cases and run status are persisted after completion', async () => {
    const store = new RunStore(new DatabaseSync(':memory:'));
    const emitter = new EvalEmitter();
    let capturedRunId = '';
    emitter.on('run:start', (d) => {
      capturedRunId = d.runId;
    });

    const ds = dataset<Item>([
      { input: 'x', expected: 'x' },
      { input: 'y', expected: 'y' },
      { input: 'z', expected: 'z' },
    ]);

    await runEval({
      name: 'persistence-test',
      model: 'test-model',
      dataset: ds,
      task: echoTask,
      scorers: { exact: exactMatch },
      store,
      emitter,
    });

    assert.ok(
      capturedRunId,
      'runId should have been captured from run:start event',
    );

    const cases = store.getCases(capturedRunId);
    assert.strictEqual(cases.length, 3);

    const run = store.getRun(capturedRunId);
    assert.ok(run, 'run should exist in store');
    assert.strictEqual(run.status, 'completed');
    assert.ok(run.summary, 'run should have a summary');
    assert.strictEqual(run.summary!.totalCases, 3);
    assert.strictEqual(run.summary!.passCount, 3);
  });
});
