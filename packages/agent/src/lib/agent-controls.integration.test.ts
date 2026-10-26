import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { type UIMessage, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { z } from 'zod';

import {
  type Agent,
  type SwarmContext,
  agent,
  execute,
  generate,
  swarm,
} from '@deepagents/agent';

for (const mode of ['generate', 'execute'] as const) {
  for (const decisions of [
    [true, true],
    [true, false],
    [false, true],
  ]) {
    it(`${mode} handles duplicate or conflicting UI approvals ${decisions.join('/')} without repeating execution`, async () => {
      let runs = 0;
      const usage = {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      };
      const finishReason = { unified: 'stop' as const, raw: undefined };
      const model = new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'Done.' }],
          finishReason,
          usage,
          warnings: [],
        }),
        doStream: async () => ({
          stream: ReadableStream.from<LanguageModelV4StreamPart>([
            { type: 'text-start', id: 'answer' },
            { type: 'text-delta', id: 'answer', delta: 'Done.' },
            { type: 'text-end', id: 'answer' },
            { type: 'finish', finishReason, usage },
          ]),
        }),
      });
      const assistant = agent({
        name: 'approvals',
        prompt: 'Help.',
        model,
        tools: {
          record: tool({
            inputSchema: z.object({}),
            needsApproval: true,
            execute: () => ++runs,
          }),
        },
      });
      const messages: UIMessage[] = [
        {
          id: 'response',
          role: 'assistant',
          parts: decisions.map((approved) => ({
            type: 'tool-record',
            toolCallId: 'record-once',
            state: 'approval-responded',
            input: {},
            approval: { id: 'approval', approved },
          })),
        },
      ];

      if (mode === 'generate') {
        assert.equal((await generate(assistant, messages, {})).text, 'Done.');
      } else {
        const result = await execute(assistant, messages, {});
        await result.consumeStream();
        assert.equal(await result.text, 'Done.');
      }
      assert.equal(runs, decisions.every(Boolean) ? 1 : 0);
      assert.equal(
        model.doGenerateCalls.length + model.doStreamCalls.length,
        1,
      );
    });
  }
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/**
 * A model whose first step calls the given tools and whose second step answers
 * "Done.", in both generate and stream form.
 */
function toolCallingModel(calls: string[]): MockLanguageModelV4 {
  const toolCalls = calls.map((toolName, index) => ({
    type: 'tool-call' as const,
    toolCallId: `${toolName}-${index}`,
    toolName,
    input: '{}',
  }));
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doGenerate: async () => ({
      content:
        model.doGenerateCalls.length === 1
          ? toolCalls
          : [{ type: 'text', text: 'Done.' }],
      finishReason: {
        unified: model.doGenerateCalls.length === 1 ? 'tool-calls' : 'stop',
        raw: undefined,
      },
      usage,
      warnings: [],
    }),
    doStream: async () => ({
      stream: ReadableStream.from<LanguageModelV4StreamPart>([
        ...(model.doStreamCalls.length === 1
          ? toolCalls
          : [
              { type: 'text-start' as const, id: 'answer' },
              { type: 'text-delta' as const, id: 'answer', delta: 'Done.' },
              { type: 'text-end' as const, id: 'answer' },
            ]),
        {
          type: 'finish',
          finishReason: {
            unified: model.doStreamCalls.length === 1 ? 'tool-calls' : 'stop',
            raw: undefined,
          },
          usage,
        },
      ]),
    }),
  });
  return model;
}

const modes = ['generate', 'execute', 'asTool', 'clone'] as const;

/**
 * Runs the agent the way each entry point does and returns what the caller
 * reads: the text and the content parts of the final step.
 */
async function run(
  mode: (typeof modes)[number],
  assistant: Agent,
  contextVariables: SwarmContext = {},
): Promise<{ text: string; content: unknown[] }> {
  if (mode === 'generate' || mode === 'clone') {
    const subject = mode === 'clone' ? assistant.clone() : assistant;
    const result = await generate(subject, 'Go.', contextVariables);
    return { text: result.text, content: result.content };
  }
  if (mode === 'execute') {
    const result = await execute(assistant, 'Go.', contextVariables);
    await result.consumeStream({
      onError: (error) => {
        throw error;
      },
    });
    return { text: await result.text, content: await result.content };
  }
  let content: unknown[] = [];
  const subagent = assistant.asTool({
    outputExtractor: (result) => {
      content = result.content;
      return result.text;
    },
  });
  assert.ok(subagent.execute);
  const text = await subagent.execute(
    { input: 'Go.' },
    { toolCallId: 'subagent', messages: [], context: contextVariables },
  );
  return { text: String(text), content };
}

for (const mode of modes) {
  it(`${mode} sends reasoning and maxOutputTokens on every model request, including a step whose active agent is unknown`, async () => {
    const model = toolCallingModel(['lookup']);
    const assistant = agent({
      name: 'controls',
      prompt: 'Help.',
      model,
      reasoning: 'low',
      maxOutputTokens: 128,
      tools: { lookup: tool({ inputSchema: z.object({}), execute: () => 1 }) },
    });

    const { text } = await run(mode, assistant, {
      currentActiveAgent: 'missing',
    });

    assert.equal(text, 'Done.');
    const requests = [...model.doGenerateCalls, ...model.doStreamCalls];
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.reasoning, 'low');
      assert.equal(request.maxOutputTokens, 128);
    }
  });

  it(`${mode} denies a tool by toolApproval before it executes`, async () => {
    let runs = 0;
    const assistant = agent({
      name: 'controls',
      prompt: 'Help.',
      model: toolCallingModel(['blocked']),
      toolApproval: { blocked: 'denied' },
      tools: {
        blocked: tool({ inputSchema: z.object({}), execute: () => ++runs }),
      },
    });

    const { text } = await run(mode, assistant);

    assert.equal(text, 'Done.');
    assert.equal(runs, 0);
  });

  it(`${mode} runs one tool call at a time with toolCallConcurrency 1`, async () => {
    let running = 0;
    let mostAtOnce = 0;
    const slow = tool({
      inputSchema: z.object({}),
      execute: async () => {
        mostAtOnce = Math.max(mostAtOnce, ++running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running--;
        return 'ok';
      },
    });
    const assistant = agent({
      name: 'controls',
      prompt: 'Help.',
      model: toolCallingModel(['slow', 'slow']),
      toolCallConcurrency: 1,
      tools: { slow },
    });

    const { text } = await run(mode, assistant);

    assert.equal(text, 'Done.');
    assert.equal(mostAtOnce, 1);
  });

  it(
    `${mode} ends a model call that never answers when the timeout passes`,
    { timeout: 2_000 },
    async () => {
      const never = (abortSignal: AbortSignal | undefined) =>
        new Promise<never>((_, reject) => {
          abortSignal?.addEventListener('abort', () =>
            reject(abortSignal.reason),
          );
        });
      const assistant = agent({
        name: 'controls',
        prompt: 'Help.',
        model: new MockLanguageModelV4({
          doGenerate: ({ abortSignal }) => never(abortSignal),
          doStream: ({ abortSignal }) => never(abortSignal),
        }),
        timeout: { totalMs: 20 },
      });

      const outcome = await run(mode, assistant).then(
        ({ text }) => text,
        (error: unknown) => String(error),
      );

      assert.match(outcome, /aborted due to timeout/);
    },
  );

  it(`${mode} signs a tool approval request with experimental_toolApprovalSecret`, async () => {
    const assistant = agent({
      name: 'controls',
      prompt: 'Help.',
      model: toolCallingModel(['guarded']),
      experimental_toolApprovalSecret: 'secret',
      tools: {
        guarded: tool({
          inputSchema: z.object({}),
          needsApproval: true,
          execute: () => 'ran',
        }),
      },
    });

    const { content } = await run(mode, assistant);

    const request = content.find(
      (part) =>
        typeof part === 'object' &&
        part !== null &&
        'type' in part &&
        part.type === 'tool-approval-request',
    );
    assert.ok(request && typeof request === 'object');
    assert.ok('signature' in request && typeof request.signature === 'string');
  });
}

it('an agent handed off to as a clone answers with its own reasoning and maxOutputTokens', async () => {
  const subagentModel = new MockLanguageModelV4({
    doStream: async () => ({
      stream: ReadableStream.from<LanguageModelV4StreamPart>([
        { type: 'text-start', id: 'answer' },
        { type: 'text-delta', id: 'answer', delta: 'Researched.' },
        { type: 'text-end', id: 'answer' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: undefined },
          usage,
        },
      ]),
    }),
  });
  const supervisorModel = new MockLanguageModelV4({
    doStream: async () => ({
      stream: ReadableStream.from<LanguageModelV4StreamPart>([
        {
          type: 'tool-call',
          toolCallId: 'handoff',
          toolName: 'transfer_to_researcher',
          input: '{}',
        },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage,
        },
      ]),
    }),
  });
  const researcher = agent({
    name: 'researcher',
    prompt: 'Research.',
    model: subagentModel,
    reasoning: 'high',
    maxOutputTokens: 64,
  });
  // createSupervisor (not exported) hands off to a clone of each subagent.
  const supervisor = agent({
    name: 'supervisor',
    prompt: 'Coordinate.',
    model: supervisorModel,
    handoffs: [researcher.clone()],
  });

  const result = await execute(supervisor, 'Go.', {});
  await result.consumeStream({
    onError: (error) => {
      throw error;
    },
  });

  assert.equal(await result.text, 'Researched.');
  assert.equal(subagentModel.doStreamCalls.length, 1);
  assert.equal(subagentModel.doStreamCalls[0].reasoning, 'high');
  assert.equal(subagentModel.doStreamCalls[0].maxOutputTokens, 64);
});

it('swarm stops prepareEnd continuation after an interrupted model response', async () => {
  let continuations = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: ReadableStream.from<LanguageModelV4StreamPart>([
        { type: 'text-start', id: 'partial' },
        { type: 'text-delta', id: 'partial', delta: 'Partial.' },
        { type: 'text-end', id: 'partial' },
        {
          type: 'finish',
          finishReason: { unified: 'interrupted', raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ]),
    }),
  });
  const assistant = agent({
    name: 'root',
    prompt: 'Help.',
    model,
    prepareEnd: () => {
      continuations++;
    },
  });

  const chunks = await Array.fromAsync(
    swarm(assistant, 'Go.', { currentActiveAgent: 'specialist' }),
  );

  assert.equal(continuations, 0);
  assert.equal(model.doStreamCalls.length, 1);
  assert.ok(
    chunks.some(
      (chunk) => chunk.type === 'text-delta' && chunk.delta === 'Partial.',
    ),
  );
  assert.ok(
    chunks.some(
      (chunk) =>
        chunk.type === 'finish' && chunk.finishReason === 'interrupted',
    ),
  );
});
