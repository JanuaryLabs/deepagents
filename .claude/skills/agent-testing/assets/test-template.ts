import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert';
import { describe, it } from 'node:test';

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 4, text: 4, reasoning: 0 },
} as const;

const response = {
  content: [{ type: 'text', text: 'expected response' }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage,
  warnings: [],
} satisfies LanguageModelV4GenerateResult;

describe('<subject under test>', () => {
  it('<describes observable behavior>', async () => {
    const model = new MockLanguageModelV4({ doGenerate: response });
    const result = await generateText({ model, prompt: 'input' });

    assert.deepStrictEqual(
      { text: result.text, calls: model.doGenerateCalls.length },
      { text: 'expected response', calls: 1 },
    );
  });
});
