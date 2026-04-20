import { generateText, stepCountIs } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { createBashTool } from '@deepagents/context';

const testUsage = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 10,
    text: 10,
    reasoning: undefined,
  },
} as const;

function createBashToolCallModel(input: string) {
  return new MockLanguageModelV3({
    doGenerate: {
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage: testUsage,
      warnings: [],
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'bash',
          input,
        },
      ],
    },
  });
}

async function runBashToolCall(input: string) {
  const { tools } = await createBashTool({});

  const result = await generateText({
    model: createBashToolCallModel(input),
    prompt: 'test-input',
    stopWhen: stepCountIs(1),
    tools: { bash: tools.bash },
  });

  return result.content as Array<{
    type: string;
    toolName?: string;
    error?: unknown;
    output?: {
      stdout: string;
      stderr: string;
      exitCode: number;
    };
  }>;
}

describe('bash tool reasoning contract', () => {
  it('schema rejects missing reasoning', async () => {
    const content = await runBashToolCall(`{"command":"echo hello"}`);

    const toolError = content.find(
      (part) => part.type === 'tool-error' && part.toolName === 'bash',
    );
    assert.ok(toolError, 'Expected bash tool call to fail validation');
    assert.match(String(toolError.error), /reasoning/i);
  });

  it('schema accepts command with non-empty reasoning', async () => {
    const content = await runBashToolCall(
      `{"command":"echo hello","reasoning":"Read command output for report assembly."}`,
    );

    const toolError = content.find(
      (part) => part.type === 'tool-error' && part.toolName === 'bash',
    );
    assert.strictEqual(toolError, undefined);

    const toolResult = content.find(
      (part) => part.type === 'tool-result' && part.toolName === 'bash',
    );
    assert.ok(toolResult, 'Expected bash tool call to succeed');
  });

  it('execution succeeds and output shape is unchanged when reasoning is provided', async () => {
    const content = await runBashToolCall(
      `{"command":"echo hello","reasoning":"Verify wrapped bash execution path."}`,
    );

    const toolResult = content.find(
      (part) => part.type === 'tool-result' && part.toolName === 'bash',
    );
    assert.ok(toolResult, 'Expected bash tool call to succeed');
    assert.ok(toolResult.output, 'Expected bash tool output');
    assert.strictEqual(toolResult.output.exitCode, 0);
    assert.strictEqual(toolResult.output.stderr, '');
    assert.ok(toolResult.output.stdout.includes('hello'));
  });
});
