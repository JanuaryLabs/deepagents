import { isStepCount, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';

import {
  ContextEngine,
  InMemoryContextStore,
  structuredOutput,
  user,
} from '@deepagents/context';

import { usage } from '../../test/helpers/usage.ts';

for (const mode of ['generate', 'stream'] as const) {
  test(`structured ${mode} respects the caller's retrieval budget`, async () => {
    let requests = 0;
    let lookups = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content:
          ++requests === 1
            ? [
                {
                  type: 'tool-call',
                  toolCallId: 'lookup',
                  toolName: 'lookup',
                  input: '{}',
                },
              ]
            : [{ type: 'text', text: '{"decision":"silent"}' }],
        finishReason: {
          unified: requests === 1 ? 'tool-calls' : 'stop',
          raw: undefined,
        },
        usage,
        warnings: [],
      }),
      doStream: async () => {
        requests++;
        return {
          stream: ReadableStream.from([
            ...(requests === 1
              ? [
                  {
                    type: 'tool-call' as const,
                    toolCallId: 'lookup',
                    toolName: 'lookup',
                    input: '{}',
                  },
                ]
              : [
                  { type: 'text-start' as const, id: 'result' },
                  {
                    type: 'text-delta' as const,
                    id: 'result',
                    delta: '{"decision":"silent"}',
                  },
                  { type: 'text-end' as const, id: 'result' },
                ]),
            {
              type: 'finish' as const,
              finishReason: {
                unified:
                  requests === 1 ? ('tool-calls' as const) : ('stop' as const),
                raw: undefined,
              },
              usage,
            },
          ]),
        };
      },
    });
    const output = structuredOutput({
      model,
      context: new ContextEngine({
        store: new InMemoryContextStore(),
        chatId: mode,
        userId: 'observer',
      }).set(user('Inspect the event and decide whether to notify.')),
      schema: z.object({ decision: z.literal('silent') }),
      tools: {
        lookup: tool({ inputSchema: z.object({}), execute: () => ++lookups }),
      },
      stopWhen: isStepCount(1),
    });
    // The model asks for a read but supplies no final object in its first step.
    // Exhausting the budget must fail, rather than silently sampling again.
    if (mode === 'generate') {
      await assert.rejects(() => output.generate(), {
        name: 'AI_NoOutputGeneratedError',
      });
    } else {
      const result = await output.stream();
      const rejected = assert.rejects(async () => result.output, {
        name: 'AI_NoObjectGeneratedError',
      });
      await result.consumeStream();
      await rejected;
    }
    assert.equal(requests, 1);
    assert.equal(lookups, 1);
  });
}
