import assert from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  csvReporter,
  htmlReporter,
  jsonReporter,
  markdownReporter,
} from '@deepagents/evals/reporters';
import type { CaseResult, RunEndData } from '@deepagents/evals/reporters';

describe('reporters serialization', () => {
  let outputDir = '';

  afterEach(async () => {
    if (outputDir) {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('serializes reporter payloads with plain JSON.stringify behavior', async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'eval-reporters-'));

    const caseResult: CaseResult = {
      runId: '12345678-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      index: 0,
      input: {
        question: 'how many?',
        context: { city: 'Cairo' },
      },
      output: 'output-value',
      expected: {
        answer: '7',
      },
      scores: {
        accuracy: {
          score: 0.5,
          reason: 'partial',
        },
      },
      error: new Error('boom'),
      latencyMs: 25,
      tokensIn: 3,
      tokensOut: 5,
    };

    const runData: RunEndData = {
      runId: caseResult.runId,
      name: 'serialize',
      model: 'test-model',
      threshold: 0.8,
      cases: [caseResult],
      summary: {
        totalCases: 1,
        passCount: 0,
        failCount: 1,
        meanScores: { accuracy: 0.5 },
        totalLatencyMs: 25,
        totalTokensIn: 3,
        totalTokensOut: 5,
      },
    };

    const json = jsonReporter({ outputDir, pretty: true });
    await json.onRunStart?.({
      runId: runData.runId,
      name: runData.name,
      model: runData.model,
      totalCases: runData.summary.totalCases,
    });
    await json.onCaseEnd?.(caseResult);
    await json.onRunEnd?.(runData);

    await csvReporter({ outputDir }).onRunEnd?.(runData);
    await markdownReporter({ outputDir }).onRunEnd?.(runData);
    await htmlReporter({ outputDir }).onRunEnd?.(runData);

    const jsonl = await readFile(
      join(outputDir, 'serialize-12345678.jsonl'),
      'utf-8',
    );
    const jsonContent = await readFile(
      join(outputDir, 'serialize-12345678.json'),
      'utf-8',
    );
    const csv = await readFile(
      join(outputDir, 'serialize-12345678.csv'),
      'utf-8',
    );
    const markdown = await readFile(
      join(outputDir, 'serialize-12345678.md'),
      'utf-8',
    );
    const html = await readFile(
      join(outputDir, 'serialize-12345678.html'),
      'utf-8',
    );

    assert.match(jsonl, /"error":\{\}/);
    assert.match(jsonContent, /"error":\s*\{\}/);
    assert.ok(!jsonContent.includes('"message":"boom"'));
    assert.ok(jsonContent.includes('"question": "how many?"'));
    assert.ok(jsonContent.includes('"answer": "7"'));

    assert.ok(csv.includes('{}'));

    assert.ok(markdown.includes('{}'));
    assert.ok(html.includes('{}'));
  });
});
