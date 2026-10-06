import assert from 'node:assert';
import { describe, it } from 'node:test';

import { consoleReporter } from '@deepagents/evals/reporters';
import type { RunEndData } from '@deepagents/evals/reporters';

describe('consoleReporter', () => {
  it('prints scorer rationale from metadata when reason is missing', async (t) => {
    const logs: string[] = [];
    const writes: string[] = [];
    t.mock.method(console, 'log', (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    t.mock.method(process.stdout, 'write', (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });

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

    await reporter.onRunEnd?.(runData);

    const combined = [...writes, ...logs].join('\n');
    assert.match(
      combined,
      /Judge rationale: output query does not match expected semantics\./,
    );
  });
});
