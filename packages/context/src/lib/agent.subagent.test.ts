import { APICallError, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import z from 'zod';

import {
  ContextEngine,
  InMemoryContextStore,
  XmlRenderer,
  agent,
  createBashTool,
  hint,
  mapGenerateErrorToCode,
  role,
  user,
} from '@deepagents/context';

const sandbox = await createBashTool();

const testUsage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 5,
    text: 5,
    reasoning: undefined,
  },
} as const;

function extractSystemPrompt(
  prompt: Array<{ role: string; content?: string }>,
): string | undefined {
  const systemMsg = prompt.find((m) => m.role === 'system');
  return systemMsg?.content;
}

function createGenerateModel(responseText?: string) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      finishReason: { unified: 'stop' as const, raw: '' },
      usage: testUsage,
      warnings: [],
      content: [
        {
          type: 'text' as const,
          text: responseText ?? 'Generated response.',
        },
      ],
    }),
  });
}

function createExecutorModel(advisorCallCount: number) {
  let step = 0;
  const totalSteps = advisorCallCount + 1;

  return new MockLanguageModelV3({
    doGenerate: async () => {
      step++;
      if (step < totalSteps) {
        return {
          finishReason: { unified: 'tool-calls' as const, raw: '' },
          usage: testUsage,
          warnings: [],
          content: [
            {
              type: 'tool-call' as const,
              toolCallType: 'function' as const,
              toolCallId: `advisor-${step}`,
              toolName: 'advisor',
              input: '{}',
            },
          ],
        };
      }

      return {
        finishReason: { unified: 'stop' as const, raw: '' },
        usage: testUsage,
        warnings: [],
        content: [{ type: 'text' as const, text: 'Task complete.' }],
      };
    },
  });
}

function createToolCallerModel(toolName: string, toolInput: string) {
  let step = 0;

  return new MockLanguageModelV3({
    doGenerate: async () => {
      step++;
      if (step === 1) {
        return {
          finishReason: { unified: 'tool-calls' as const, raw: '' },
          usage: testUsage,
          warnings: [],
          content: [
            {
              type: 'tool-call' as const,
              toolCallType: 'function' as const,
              toolCallId: 'tc-1',
              toolName,
              input: toolInput,
            },
          ],
        };
      }
      return {
        finishReason: { unified: 'stop' as const, raw: '' },
        usage: testUsage,
        warnings: [],
        content: [{ type: 'text' as const, text: 'Done.' }],
      };
    },
  });
}

function createContext(...fragments: Parameters<ContextEngine['set']>) {
  const ctx = new ContextEngine({
    store: new InMemoryContextStore(),
    chatId: crypto.randomUUID(),
    userId: 'test',
  });
  ctx.set(...fragments);
  return ctx;
}

function createThrowingAdvisorModel(errorFactory: () => Error) {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw errorFactory();
    },
  });
}

function createAPICallError(statusCode: number, message = 'API error') {
  return new APICallError({
    message,
    url: 'https://api.test.com',
    requestBodyValues: {},
    statusCode,
    isRetryable: false,
  });
}

describe('ContextEngine.fork', () => {
  it('creates an independent context with same fragments', async () => {
    const ctx = createContext(role('You are a helpful assistant.'));
    const forked = ctx.fork();

    assert.notStrictEqual(ctx.chatId, forked.chatId);

    const renderer = new XmlRenderer();
    const original = await ctx.resolve({ renderer });
    const forkedResult = await forked.resolve({ renderer });

    assert.strictEqual(original.systemPrompt, forkedResult.systemPrompt);
    assert.strictEqual(original.messages.length, 0);
    assert.strictEqual(forkedResult.messages.length, 0);
  });

  it('preserves multiple fragment types', async () => {
    const ctx = createContext(
      role('You are a data analyst.'),
      hint('Always use UTC timestamps.'),
    );
    const forked = ctx.fork();

    const renderer = new XmlRenderer();
    const original = await ctx.resolve({ renderer });
    const forkedResult = await forked.resolve({ renderer });

    assert.ok(original.systemPrompt.includes('data analyst'));
    assert.ok(original.systemPrompt.includes('UTC timestamps'));
    assert.strictEqual(original.systemPrompt, forkedResult.systemPrompt);
  });

  it('does not share message state with parent', async () => {
    const ctx = createContext(role('Test role.'));

    ctx.set(user('Hello from parent'));
    const forked = ctx.fork();

    const renderer = new XmlRenderer();
    const parentResult = await ctx.resolve({ renderer });
    const forkedResult = await forked.resolve({ renderer });

    assert.strictEqual(parentResult.messages.length, 1);
    assert.strictEqual(forkedResult.messages.length, 0);
  });
});

describe('asTool', () => {
  it('creates a tool that delegates to the agent and returns results', async () => {
    const subModel = createGenerateModel('Sub-agent result.');

    const subAgent = agent({
      sandbox,
      name: 'researcher',
      model: subModel,
      context: createContext(role('You are a research agent.')),
    });

    const subTool = subAgent.asTool({
      toolDescription: 'Delegate research tasks.',
    });

    const callerModel = createToolCallerModel(
      'researcher',
      JSON.stringify({ input: 'Find info about TypeScript.' }),
    );

    const callerCtx = createContext(role('You orchestrate tasks.'));
    callerCtx.set(user('Do research on TypeScript.'));

    const callerAgent = agent({
      sandbox,
      name: 'orchestrator',
      model: callerModel,
      context: callerCtx,
      tools: { researcher: subTool },
    });

    const result = await callerAgent.generate({});

    assert.ok(subModel.doGenerateCalls.length >= 1);
    const subPrompt = subModel.doGenerateCalls[0]!.prompt as Array<{
      role: string;
      content?: unknown;
    }>;
    const systemPrompt = extractSystemPrompt(
      subPrompt as Array<{ role: string; content?: string }>,
    );
    assert.ok(systemPrompt?.includes('research agent'));
  });

  it('uses outputExtractor when provided', async () => {
    const subModel = createGenerateModel('Raw sub-agent text.');

    const subAgent = agent({
      sandbox,
      name: 'extractor-agent',
      model: subModel,
      context: createContext(role('You extract data.')),
    });

    const subTool = subAgent.asTool({
      outputExtractor: async (result) => `EXTRACTED: ${result.text}`,
    });

    const callerModel = createToolCallerModel(
      'extractor-agent',
      JSON.stringify({ input: 'Extract this' }),
    );

    const callerCtx = createContext(role('Caller.'));
    callerCtx.set(user('Extract data.'));

    const callerAgent = agent({
      sandbox,
      name: 'caller',
      model: callerModel,
      context: callerCtx,
      tools: { 'extractor-agent': subTool },
    });

    const result = await callerAgent.generate({});

    const allToolResults = result.steps.flatMap((s) => s.toolResults);
    const extracted = allToolResults.find(
      (tr: any) =>
        typeof tr.output === 'string' && tr.output.startsWith('EXTRACTED:'),
    );
    assert.ok(extracted, 'Should have a tool result with extracted output');
    assert.strictEqual(
      (extracted as any).output,
      'EXTRACTED: Raw sub-agent text.',
    );
  });

  it('forwards output instructions to sub-agent prompt', async () => {
    const subModel = createGenerateModel('Formatted result.');

    const subAgent = agent({
      sandbox,
      name: 'formatter',
      model: subModel,
      context: createContext(role('You format data.')),
    });

    const subTool = subAgent.asTool();

    const callerModel = createToolCallerModel(
      'formatter',
      JSON.stringify({
        input: 'Raw data here',
        output: 'Return as JSON array',
      }),
    );

    const callerCtx = createContext(role('Caller.'));
    callerCtx.set(user('Format this data.'));

    const callerAgent = agent({
      sandbox,
      name: 'caller',
      model: callerModel,
      context: callerCtx,
      tools: { formatter: subTool },
    });

    await callerAgent.generate({});

    const subPrompt = subModel.doGenerateCalls[0]!.prompt as Array<{
      role: string;
      content?: unknown[];
    }>;
    const userMsg = subPrompt.find((m) => m.role === 'user');
    const textContent = JSON.stringify(userMsg?.content);
    assert.ok(textContent.includes('Raw data here'));
    assert.ok(textContent.includes('OutputInstructions'));
    assert.ok(textContent.includes('Return as JSON array'));
  });

  it('returns error string when sub-agent fails', async () => {
    const failingModel = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error('Model API unavailable');
      },
    });

    const subAgent = agent({
      sandbox,
      name: 'failing-agent',
      model: failingModel,
      context: createContext(role('You fail.')),
    });

    const subTool = subAgent.asTool();

    const callerModel = createToolCallerModel(
      'failing-agent',
      JSON.stringify({ input: 'Try this' }),
    );

    const callerCtx = createContext(role('Caller.'));
    callerCtx.set(user('Do something.'));

    const callerAgent = agent({
      sandbox,
      name: 'caller',
      model: callerModel,
      context: callerCtx,
      tools: { 'failing-agent': subTool },
    });

    const result = await callerAgent.generate({});

    const allToolResults = result.steps.flatMap((s) => s.toolResults);
    const errorResult = allToolResults.find(
      (tr: any) =>
        typeof tr.output === 'string' && tr.output.includes('ErrorDetails'),
    );
    assert.ok(errorResult, 'Should have an error tool result');
    assert.ok(
      (errorResult as any).output.includes('Model API unavailable'),
      'Error message should be preserved',
    );
  });

  it('passes tools to sub-agent', async () => {
    let lookupCalled = false;
    const lookupTool = tool({
      description: 'Look up data',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        lookupCalled = true;
        return `Data for ${id}`;
      },
    });

    let subStep = 0;
    const subModel = new MockLanguageModelV3({
      doGenerate: async () => {
        subStep++;
        if (subStep === 1) {
          return {
            finishReason: { unified: 'tool-calls' as const, raw: '' },
            usage: testUsage,
            warnings: [],
            content: [
              {
                type: 'tool-call' as const,
                toolCallType: 'function' as const,
                toolCallId: 'sub-tc-1',
                toolName: 'lookup',
                input: '{"id":"abc"}',
              },
            ],
          };
        }
        return {
          finishReason: { unified: 'stop' as const, raw: '' },
          usage: testUsage,
          warnings: [],
          content: [{ type: 'text' as const, text: 'Looked up.' }],
        };
      },
    });

    const subAgent = agent({
      sandbox,
      name: 'data-agent',
      model: subModel,
      context: createContext(role('You look up data.')),
      tools: { lookup: lookupTool },
    });

    const subTool = subAgent.asTool();

    const callerModel = createToolCallerModel(
      'data-agent',
      JSON.stringify({ input: 'Look up abc' }),
    );

    const callerCtx = createContext(role('Caller.'));
    callerCtx.set(user('Get data.'));

    const callerAgent = agent({
      sandbox,
      name: 'caller',
      model: callerModel,
      context: callerCtx,
      tools: { 'data-agent': subTool },
    });

    await callerAgent.generate({});

    assert.ok(lookupCalled, 'Sub-agent should have called the lookup tool');
  });

  it('propagates abort signal to sub-agent', async () => {
    const abortController = new AbortController();
    const subModel = createGenerateModel();

    const subAgent = agent({
      sandbox,
      name: 'sub',
      model: subModel,
      context: createContext(role('Sub.')),
    });

    const subTool = subAgent.asTool();

    const callerModel = createToolCallerModel(
      'sub',
      JSON.stringify({ input: 'Do it' }),
    );

    const callerCtx = createContext(role('Caller.'));
    callerCtx.set(user('Go.'));

    const callerAgent = agent({
      sandbox,
      name: 'caller',
      model: callerModel,
      context: callerCtx,
      tools: { sub: subTool },
    });

    await callerAgent.generate({}, { abortSignal: abortController.signal });

    assert.strictEqual(
      subModel.doGenerateCalls[0]!.abortSignal,
      abortController.signal,
    );
  });

  it('isolates each invocation with a fresh context', async () => {
    const subModel = createGenerateModel('Response.');

    const ctx = createContext(role('Test role.'));
    const subAgent = agent({
      sandbox,
      name: 'worker',
      model: subModel,
      context: ctx,
    });

    const workerTool = subAgent.asTool();

    const callerModel = createToolCallerModel(
      'worker',
      JSON.stringify({ input: 'First call' }),
    );

    const callerCtx = createContext(role('Caller.'));
    callerCtx.set(user('Do work.'));

    const callerAgent = agent({
      sandbox,
      name: 'caller',
      model: callerModel,
      context: callerCtx,
      tools: { worker: workerTool },
    });

    await callerAgent.generate({});

    const parentResult = await ctx.resolve({ renderer: new XmlRenderer() });
    assert.strictEqual(
      parentResult.messages.length,
      0,
      'Parent context should have no messages after asTool invocation',
    );
  });
});

describe('asAdvisor', () => {
  it('forwards full context to the advisor model and returns advice', async () => {
    const advisorModel = createGenerateModel(
      '1. Start with the database schema\n2. Add indexes',
    );
    const executorModel = createExecutorModel(1);

    const advisorAgent = agent({
      sandbox,
      name: 'strategic-advisor',
      model: advisorModel,
      context: createContext(role('You are a coding assistant.')),
    });

    const { tool: advisorTool } = advisorAgent.asAdvisor();

    const executorCtx = createContext(role('You solve tasks.'));
    executorCtx.set(user('Fix the performance issue'));

    const executorAgent = agent({
      sandbox,
      name: 'executor',
      model: executorModel,
      context: executorCtx,
      tools: { advisor: advisorTool },
    });

    const result = await executorAgent.generate({});

    assert.strictEqual(advisorModel.doGenerateCalls.length, 1);
    const advisorPrompt = advisorModel.doGenerateCalls[0]!.prompt as Array<{
      role: string;
      content?: string;
    }>;
    const systemPrompt = extractSystemPrompt(advisorPrompt);
    assert.ok(systemPrompt?.includes('coding assistant'));
    assert.ok(systemPrompt?.includes('advisor providing strategic guidance'));
    assert.strictEqual(result.text, 'Task complete.');
  });

  it('enforces maxUses and returns error on excess calls', async () => {
    const advisorModel = createGenerateModel();
    const executorModel = createExecutorModel(3);

    const advisorAgent = agent({
      sandbox,
      name: 'advisor',
      model: advisorModel,
      context: createContext(role('Test system prompt.')),
    });

    const { tool: advisorTool, usage: getUsage } = advisorAgent.asAdvisor({
      maxUses: 2,
    });

    const executorCtx = createContext(role('You solve tasks.'));
    executorCtx.set(user('Do the task'));

    const executorAgent = agent({
      sandbox,
      name: 'executor',
      model: executorModel,
      context: executorCtx,
      tools: { advisor: advisorTool },
    });

    await executorAgent.generate({});

    assert.strictEqual(advisorModel.doGenerateCalls.length, 2);
    assert.strictEqual(getUsage().calls, 2);
  });

  it('accumulates usage across multiple advisor calls', async () => {
    const advisorModel = createGenerateModel();
    const executorModel = createExecutorModel(3);

    const advisorAgent = agent({
      sandbox,
      name: 'advisor',
      model: advisorModel,
      context: createContext(role('Test.')),
    });

    const { tool: advisorTool, usage: getUsage } = advisorAgent.asAdvisor();

    const executorCtx = createContext(role('Solve.'));
    executorCtx.set(user('Work on it'));

    const executorAgent = agent({
      sandbox,
      name: 'executor',
      model: executorModel,
      context: executorCtx,
      tools: { advisor: advisorTool },
    });

    await executorAgent.generate({});

    const usage = getUsage();
    assert.strictEqual(usage.calls, 3);
    assert.strictEqual(usage.totalUsage.inputTokens, 30);
    assert.strictEqual(usage.totalUsage.outputTokens, 15);
  });

  it('propagates abort signal to the advisor model', async () => {
    const abortController = new AbortController();
    const advisorModel = createGenerateModel();
    const executorModel = createExecutorModel(1);

    const advisorAgent = agent({
      sandbox,
      name: 'advisor',
      model: advisorModel,
      context: createContext(role('Test.')),
    });

    const { tool: advisorTool } = advisorAgent.asAdvisor();

    const executorCtx = createContext(role('Executor.'));
    executorCtx.set(user('Do it'));

    const executorAgent = agent({
      sandbox,
      name: 'executor',
      model: executorModel,
      context: executorCtx,
      tools: { advisor: advisorTool },
    });

    await executorAgent.generate({}, { abortSignal: abortController.signal });

    assert.strictEqual(
      advisorModel.doGenerateCalls[0]!.abortSignal,
      abortController.signal,
    );
  });
});

describe('mapGenerateErrorToCode', () => {
  it('maps 429 to too_many_requests', () => {
    assert.strictEqual(
      mapGenerateErrorToCode(createAPICallError(429)),
      'too_many_requests',
    );
  });

  it('maps 503 to overloaded', () => {
    assert.strictEqual(
      mapGenerateErrorToCode(createAPICallError(503)),
      'overloaded',
    );
  });

  it('maps 529 to overloaded', () => {
    assert.strictEqual(
      mapGenerateErrorToCode(createAPICallError(529)),
      'overloaded',
    );
  });

  it('maps 413 to prompt_too_long', () => {
    assert.strictEqual(
      mapGenerateErrorToCode(createAPICallError(413)),
      'prompt_too_long',
    );
  });

  it('maps context_length_exceeded message to prompt_too_long', () => {
    assert.strictEqual(
      mapGenerateErrorToCode(
        createAPICallError(400, 'context_length_exceeded'),
      ),
      'prompt_too_long',
    );
  });

  it('maps 5xx APICallError to unavailable', () => {
    assert.strictEqual(
      mapGenerateErrorToCode(createAPICallError(500)),
      'unavailable',
    );
  });

  it('returns null for 4xx client errors like 401', () => {
    assert.strictEqual(mapGenerateErrorToCode(createAPICallError(401)), null);
  });

  it('returns null for 403 Forbidden', () => {
    assert.strictEqual(mapGenerateErrorToCode(createAPICallError(403)), null);
  });

  it('maps TimeoutError to execution_time_exceeded', () => {
    const err = new DOMException('timeout', 'TimeoutError');
    assert.strictEqual(mapGenerateErrorToCode(err), 'execution_time_exceeded');
  });

  it('returns null for AbortError', () => {
    const err = new DOMException('aborted', 'AbortError');
    assert.strictEqual(mapGenerateErrorToCode(err), null);
  });

  it('returns null for unknown errors', () => {
    assert.strictEqual(
      mapGenerateErrorToCode(new Error('something unexpected')),
      null,
    );
  });
});

describe('asAdvisor error handling', () => {
  it('returns too_many_requests on 429 instead of throwing', async () => {
    const advisorModel = createThrowingAdvisorModel(() =>
      createAPICallError(429),
    );
    const executorModel = createExecutorModel(1);

    const advisorAgent = agent({
      sandbox,
      name: 'advisor',
      model: advisorModel,
      context: createContext(role('Test.')),
    });

    const { tool: advisorTool, usage: getUsage } = advisorAgent.asAdvisor();

    const executorCtx = createContext(role('Solve.'));
    executorCtx.set(user('Work'));

    const executorAgent = agent({
      sandbox,
      name: 'executor',
      model: executorModel,
      context: executorCtx,
      tools: { advisor: advisorTool },
    });

    const result = await executorAgent.generate({});

    assert.strictEqual(result.text, 'Task complete.');
    assert.strictEqual(getUsage().calls, 0);
  });

  it('returns prompt_too_long on 413 instead of throwing', async () => {
    const advisorModel = createThrowingAdvisorModel(() =>
      createAPICallError(413),
    );
    const executorModel = createExecutorModel(1);

    const advisorAgent = agent({
      sandbox,
      name: 'advisor',
      model: advisorModel,
      context: createContext(role('Test.')),
    });

    const { tool: advisorTool, usage: getUsage } = advisorAgent.asAdvisor();

    const executorCtx = createContext(role('Solve.'));
    executorCtx.set(user('Work'));

    const executorAgent = agent({
      sandbox,
      name: 'executor',
      model: executorModel,
      context: executorCtx,
      tools: { advisor: advisorTool },
    });

    const result = await executorAgent.generate({});

    assert.strictEqual(result.text, 'Task complete.');
    assert.strictEqual(getUsage().calls, 0);
  });

  it('returns execution_time_exceeded on TimeoutError instead of throwing', async () => {
    const advisorModel = createThrowingAdvisorModel(
      () => new DOMException('timeout', 'TimeoutError'),
    );
    const executorModel = createExecutorModel(1);

    const advisorAgent = agent({
      sandbox,
      name: 'advisor',
      model: advisorModel,
      context: createContext(role('Test.')),
    });

    const { tool: advisorTool, usage: getUsage } = advisorAgent.asAdvisor();

    const executorCtx = createContext(role('Solve.'));
    executorCtx.set(user('Work'));

    const executorAgent = agent({
      sandbox,
      name: 'executor',
      model: executorModel,
      context: executorCtx,
      tools: { advisor: advisorTool },
    });

    const result = await executorAgent.generate({});

    assert.strictEqual(result.text, 'Task complete.');
    assert.strictEqual(getUsage().calls, 0);
  });

  it('returns overloaded on 503 instead of throwing', async () => {
    const advisorModel = createThrowingAdvisorModel(() =>
      createAPICallError(503),
    );
    const executorModel = createExecutorModel(1);

    const advisorAgent = agent({
      sandbox,
      name: 'advisor',
      model: advisorModel,
      context: createContext(role('Test.')),
    });

    const { tool: advisorTool } = advisorAgent.asAdvisor();

    const executorCtx = createContext(role('Solve.'));
    executorCtx.set(user('Work'));

    const executorAgent = agent({
      sandbox,
      name: 'executor',
      model: executorModel,
      context: executorCtx,
      tools: { advisor: advisorTool },
    });

    const result = await executorAgent.generate({});
    assert.strictEqual(result.text, 'Task complete.');
  });

  it('does not map AbortError — lets it propagate to AI SDK error handling', async () => {
    const advisorModel = createThrowingAdvisorModel(
      () => new DOMException('aborted', 'AbortError'),
    );
    const executorModel = createExecutorModel(1);

    const advisorAgent = agent({
      sandbox,
      name: 'advisor',
      model: advisorModel,
      context: createContext(role('Test.')),
    });

    const { tool: advisorTool, usage: getUsage } = advisorAgent.asAdvisor();

    const executorCtx = createContext(role('Solve.'));
    executorCtx.set(user('Work'));

    const executorAgent = agent({
      sandbox,
      name: 'executor',
      model: executorModel,
      context: executorCtx,
      tools: { advisor: advisorTool },
    });

    await executorAgent.generate({});
    assert.strictEqual(
      getUsage().calls,
      0,
      'AbortError should not count as a successful advisor call',
    );
  });

  it('does not map unknown errors — lets them propagate to AI SDK error handling', async () => {
    const advisorModel = createThrowingAdvisorModel(
      () => new Error('unexpected failure'),
    );
    const executorModel = createExecutorModel(1);

    const advisorAgent = agent({
      sandbox,
      name: 'advisor',
      model: advisorModel,
      context: createContext(role('Test.')),
    });

    const { tool: advisorTool, usage: getUsage } = advisorAgent.asAdvisor();

    const executorCtx = createContext(role('Solve.'));
    executorCtx.set(user('Work'));

    const executorAgent = agent({
      sandbox,
      name: 'executor',
      model: executorModel,
      context: executorCtx,
      tools: { advisor: advisorTool },
    });

    await executorAgent.generate({});
    assert.strictEqual(
      getUsage().calls,
      0,
      'Unknown errors should not count as a successful advisor call',
    );
  });
});

describe('asAdvisor maxConversationUses', () => {
  it('enforces maxConversationUses based on successful calls', async () => {
    const advisorModel = createGenerateModel('Advice.');
    const executorModel = createExecutorModel(3);

    const advisorAgent = agent({
      sandbox,
      name: 'advisor',
      model: advisorModel,
      context: createContext(role('Test.')),
    });

    const { tool: advisorTool, usage: getUsage } = advisorAgent.asAdvisor({
      maxConversationUses: 2,
    });

    const executorCtx = createContext(role('Solve.'));
    executorCtx.set(user('Work'));

    const executorAgent = agent({
      sandbox,
      name: 'executor',
      model: executorModel,
      context: executorCtx,
      tools: { advisor: advisorTool },
    });

    await executorAgent.generate({});

    assert.strictEqual(advisorModel.doGenerateCalls.length, 2);
    assert.strictEqual(getUsage().calls, 2);
  });

  it('failed calls do not count against maxConversationUses', async () => {
    let advisorCallCount = 0;
    const advisorModel = new MockLanguageModelV3({
      doGenerate: async () => {
        advisorCallCount++;
        if (advisorCallCount === 1) {
          throw createAPICallError(429);
        }
        return {
          finishReason: { unified: 'stop' as const, raw: '' },
          usage: testUsage,
          warnings: [],
          content: [{ type: 'text' as const, text: 'Advice.' }],
        };
      },
    });

    const executorModel = createExecutorModel(3);

    const advisorAgent = agent({
      sandbox,
      name: 'advisor',
      model: advisorModel,
      context: createContext(role('Test.')),
    });

    const { tool: advisorTool, usage: getUsage } = advisorAgent.asAdvisor({
      maxConversationUses: 2,
    });

    const executorCtx = createContext(role('Solve.'));
    executorCtx.set(user('Work'));

    const executorAgent = agent({
      sandbox,
      name: 'executor',
      model: executorModel,
      context: executorCtx,
      tools: { advisor: advisorTool },
    });

    await executorAgent.generate({});

    assert.strictEqual(advisorModel.doGenerateCalls.length, 3);
    assert.strictEqual(getUsage().calls, 2);
  });
});
