import assert from 'node:assert';
import { describe, it } from 'node:test';
import type OpenAI from 'openai';

import { factuality, levenshtein, sql } from '@deepagents/evals/scorers';

function judgeClient(choice: string, requests: unknown[]): OpenAI {
  return {
    chat: {
      completions: {
        create: async (request: unknown) => {
          requests.push(request);
          return {
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      type: 'function',
                      function: {
                        name: 'select_choice',
                        arguments: JSON.stringify({
                          choice,
                          reasons: ['The answers agree.'],
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          };
        },
      },
    },
  } as unknown as OpenAI;
}

describe('built-in scorers', () => {
  it('scores Levenshtein similarity without a package-manager-bound dependency', async () => {
    const result = await levenshtein({
      input: undefined,
      output: 'kitten',
      expected: 'sitting',
    });

    assert.strictEqual(result.score, 4 / 7);
  });

  it('grades factual and SQL equivalence through a caller-provided OpenAI client', async () => {
    const factualityRequests: unknown[] = [];
    const sqlRequests: unknown[] = [];

    const factualityResult = await factuality({
      model: 'judge-model',
      client: judgeClient('C', factualityRequests),
    })({
      input: 'What is the capital of Jordan?',
      output: 'Amman.',
      expected: 'Amman is the capital of Jordan.',
    });
    const sqlResult = await sql({
      model: 'judge-model',
      client: judgeClient('Correct', sqlRequests),
    })({
      input: 'List every user.',
      output: 'SELECT * FROM users',
      expected: 'SELECT * FROM users',
    });

    assert.deepStrictEqual(factualityResult, {
      score: 1,
      reason: 'The answers agree.',
      metadata: {
        choice: 'C',
        rationale: ['The answers agree.'],
      },
    });
    assert.deepStrictEqual(sqlResult, {
      score: 1,
      reason: 'The answers agree.',
      metadata: {
        choice: 'Correct',
        rationale: ['The answers agree.'],
      },
    });
    assert.strictEqual(factualityRequests.length, 1);
    assert.strictEqual(sqlRequests.length, 1);
  });
});
