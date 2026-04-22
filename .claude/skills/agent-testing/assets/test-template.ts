import { generateText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import assert from 'node:assert';
import { describe, it } from 'node:test';

const testUsage = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
} as const;

describe('<subject under test>', () => {
  it('<describes the observable behaviour, not the mock>', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: {
        finishReason: { unified: 'stop', raw: undefined },
        usage: testUsage,
        content: [{ type: 'text', text: 'expected response' }],
        warnings: [],
      },
    });

    const result = await generateText({ model, prompt: 'input' });

    assert.deepStrictEqual(
      { text: result.text, calls: model.doGenerateCalls.length },
      { text: 'expected response', calls: 1 },
    );
  });
});
