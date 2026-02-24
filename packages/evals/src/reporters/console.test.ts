import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { consoleReporter } from '@deepagents/evals/reporters';
import type { RunEndData } from '@deepagents/evals/reporters';

describe('consoleReporter', () => {
  const originalLog = console.log;
  const originalWrite = process.stdout.write;

  const logs: string[] = [];
  const writes: string[] = [];

  afterEach(() => {
    console.log = originalLog;
    process.stdout.write = originalWrite;
    logs.length = 0;
    writes.length = 0;
  });

  it('prints scorer rationale from metadata when reason is missing', () => {
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    const reporter = consoleReporter();
    const runData: RunEndData = {
      runId: 'run-1',
      name: 'SQL Eval',
      model: 'model-x',
      threshold: 0.5,
      summary: {
        totalCases: 1,
        passCount: 0,
        failCount: 1,
        meanScores: { sql: 0.0 },
        totalLatencyMs: 120,
        totalTokensIn: 10,
        totalTokensOut: 20,
      },
      cases: [
        {
          runId: 'run-1',
          index: 0,
          input: { question: 'q' },
          output: 'SELECT 1',
          expected: 'SELECT 2',
          scores: {
            sql: {
              score: 0,
              metadata: {
                rationale:
                  'Judge rationale: output query does not match expected semantics.',
              },
            },
          },
          error: undefined,
          latencyMs: 120,
          tokensIn: 10,
          tokensOut: 20,
        },
      ],
    };

    reporter.onRunEnd?.(runData);

    const combined = [...writes, ...logs].join('\n');
    assert.match(
      combined,
      /Judge rationale: output query does not match expected semantics\./,
    );
  });
});
