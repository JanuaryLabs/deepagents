import { simulateReadableStream, stepCountIs } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  BatchTraceProcessor,
  type OpenAISpan,
  type OpenAITrace,
  OpenAITracesExporter,
  type TraceItem,
  type TracingExporter,
  createOpenAITracesIntegration,
} from '@deepagents/context/tracing';

function createMockModel(text = 'Hello world') {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: text },
          { type: 'text-end', id: 'text-1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: '' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: 7,
                cacheRead: 2,
                cacheWrite: 1,
              },
              outputTokens: {
                total: 5,
                text: 4,
                reasoning: 1,
              },
            },
          },
        ],
      }),
      rawCall: { rawPrompt: undefined, rawSettings: {} },
    }),
  });
}

function createTwoStepToolModel() {
  let callCount = 0;

  return new MockLanguageModelV3({
    doStream: async () => {
      callCount += 1;
      const chunks: any[] =
        callCount === 1
          ? [
              {
                type: 'tool-call',
                id: 'tc-1',
                toolCallId: 'call_1',
                toolName: 'get_weather',
                input: JSON.stringify({ city: 'London' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: '' },
                usage: {
                  inputTokens: {
                    total: 20,
                    noCache: undefined,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: {
                    total: 8,
                    text: 8,
                    reasoning: undefined,
                  },
                },
              },
            ]
          : [
              { type: 'text-start', id: 'text-2' },
              { type: 'text-delta', id: 'text-2', delta: 'Weather is 15C' },
              { type: 'text-end', id: 'text-2' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: '' },
                usage: {
                  inputTokens: {
                    total: 12,
                    noCache: undefined,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: {
                    total: 6,
                    text: 6,
                    reasoning: undefined,
                  },
                },
              },
            ];

      return {
        stream: simulateReadableStream({
          chunks,
        }),
        rawCall: { rawPrompt: undefined, rawSettings: {} },
      };
    },
  });
}

function createMockExporter() {
  const exported: TraceItem[][] = [];

  const exporter = new (class extends OpenAITracesExporter {
    override async export(items: TraceItem[]) {
      exported.push(structuredClone(items));
    }
  })({ apiKey: 'test-key' });

  return { exporter, exported };
}

async function flushTelemetry() {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe('OpenAI Traces Integration', () => {
  describe('createOpenAITracesIntegration', () => {
    it('produces correct trace and spans for a simple streamText call', async () => {
      const { streamText } = await import('ai');
      const { exporter, exported } = createMockExporter();

      const integration = createOpenAITracesIntegration({
        workflowName: 'test-workflow',
        groupId: 'group-123',
        metadata: { env: 'test' },
        exporter,
      });

      const result = streamText({
        model: createMockModel(),
        prompt: 'Say hello',
        experimental_telemetry: {
          isEnabled: true,
          integrations: [integration],
        },
      });

      for await (const _chunk of result.textStream) {
        // consume stream
      }

      await result.response;
      await flushTelemetry();

      assert.strictEqual(exported.length, 1, 'should have exported once');
      const items = exported[0];

      const trace = items.find((item) => item.object === 'trace') as
        | OpenAITrace
        | undefined;
      assert.ok(trace, 'should have a trace');
      assert.strictEqual(trace.workflow_name, 'test-workflow');
      assert.strictEqual(trace.group_id, 'group-123');
      assert.ok(trace.id.startsWith('trace_'));
      assert.ok(trace.metadata?.env === 'test');
      assert.deepStrictEqual(trace.metadata?.total_usage, {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        details: {
          input_token_details: {
            no_cache_tokens: 7,
            cache_read_tokens: 2,
            cache_write_tokens: 1,
          },
          output_token_details: {
            text_tokens: 4,
            reasoning_tokens: 1,
          },
          reasoning_tokens: 1,
          cached_input_tokens: 2,
        },
      });

      const spans = items.filter(
        (item) => item.object === 'trace.span',
      ) as OpenAISpan[];
      assert.ok(
        spans.length >= 2,
        `expected at least 2 spans, got ${spans.length}`,
      );

      const rootSpan = spans.find((span) => span.span_data.type === 'agent');
      assert.ok(rootSpan, 'should have a root agent span');
      assert.ok(rootSpan.ended_at, 'root span should be closed');
      assert.strictEqual(rootSpan.parent_id, null);

      const generationSpan = spans.find(
        (span) => span.span_data.type === 'generation',
      );
      assert.ok(generationSpan, 'should have a generation span');
      assert.ok(generationSpan.ended_at, 'generation span should be closed');
      assert.strictEqual(generationSpan.trace_id, trace.id);
      assert.ok(
        Array.isArray((generationSpan.span_data as { input?: unknown }).input),
        'generation input should be normalized to record arrays',
      );
      assert.ok(
        Array.isArray(
          (generationSpan.span_data as { output?: unknown }).output,
        ),
        'generation output should be normalized to record arrays',
      );
    });

    it('can be reused without leaking trace state between runs', async () => {
      const { streamText } = await import('ai');
      const { exporter, exported } = createMockExporter();

      const integration = createOpenAITracesIntegration({
        workflowName: 'reused-workflow',
        exporter,
      });

      for (const prompt of ['First run', 'Second run']) {
        const result = streamText({
          model: createMockModel(prompt),
          prompt,
          experimental_telemetry: {
            isEnabled: true,
            integrations: [integration],
          },
        });

        for await (const _chunk of result.textStream) {
          // consume stream
        }

        await result.response;
      }

      await flushTelemetry();

      assert.strictEqual(exported.length, 2);

      const firstTrace = exported[0].find(
        (item) => item.object === 'trace',
      ) as OpenAITrace;
      const secondTrace = exported[1].find(
        (item) => item.object === 'trace',
      ) as OpenAITrace;
      assert.notStrictEqual(firstTrace.id, secondTrace.id);
      assert.strictEqual(
        exported[1].filter((item) => item.object === 'trace').length,
        1,
        'each export should only contain its own trace',
      );
    });

    it('supports overlapping runs on the same integration instance', async () => {
      const { streamText } = await import('ai');
      const { exporter, exported } = createMockExporter();

      const integration = createOpenAITracesIntegration({
        workflowName: 'concurrent-workflow',
        exporter,
      });

      async function run(prompt: string) {
        const result = streamText({
          model: createMockModel(prompt),
          prompt,
          experimental_telemetry: {
            isEnabled: true,
            integrations: [integration],
          },
        });

        for await (const _chunk of result.textStream) {
          // consume stream
        }

        await result.response;
      }

      await Promise.all([run('Run A'), run('Run B')]);
      await flushTelemetry();

      assert.strictEqual(exported.length, 2);

      const traceIds = exported.map((batch) => {
        const trace = batch.find(
          (item) => item.object === 'trace',
        ) as OpenAITrace;
        return trace.id;
      });
      assert.strictEqual(new Set(traceIds).size, 2);
    });

    it('matches interleaved callbacks by event identity instead of stack order', async () => {
      const { exporter, exported } = createMockExporter();
      const integration = createOpenAITracesIntegration({
        exporter,
      });

      await integration.onStart?.({
        model: { provider: 'openai', modelId: 'gpt-5' },
        system: undefined,
        prompt: 'A',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'A' }] }],
        tools: undefined,
        toolChoice: undefined,
        activeTools: undefined,
        maxOutputTokens: undefined,
        temperature: undefined,
        topP: undefined,
        topK: undefined,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stopSequences: undefined,
        seed: undefined,
        maxRetries: 0,
        timeout: undefined,
        headers: undefined,
        providerOptions: undefined,
        stopWhen: undefined,
        output: undefined,
        abortSignal: undefined,
        include: undefined,
        functionId: 'A',
        metadata: undefined,
        experimental_context: undefined,
      });

      await integration.onStart?.({
        model: { provider: 'openai', modelId: 'gpt-5' },
        system: undefined,
        prompt: 'B',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'B' }] }],
        tools: undefined,
        toolChoice: undefined,
        activeTools: undefined,
        maxOutputTokens: undefined,
        temperature: undefined,
        topP: undefined,
        topK: undefined,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stopSequences: undefined,
        seed: undefined,
        maxRetries: 0,
        timeout: undefined,
        headers: undefined,
        providerOptions: undefined,
        stopWhen: undefined,
        output: undefined,
        abortSignal: undefined,
        include: undefined,
        functionId: 'B',
        metadata: undefined,
        experimental_context: undefined,
      });

      await integration.onStepStart?.({
        stepNumber: 0,
        model: { provider: 'openai', modelId: 'gpt-5' },
        system: undefined,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'A' }] }],
        tools: undefined,
        toolChoice: undefined,
        activeTools: undefined,
        steps: [],
        providerOptions: undefined,
        timeout: undefined,
        headers: undefined,
        stopWhen: undefined,
        output: undefined,
        abortSignal: undefined,
        include: undefined,
        functionId: 'A',
        metadata: undefined,
        experimental_context: undefined,
      });

      await integration.onStepFinish?.({
        stepNumber: 0,
        model: { provider: 'openai', modelId: 'gpt-5' },
        functionId: 'A',
        metadata: undefined,
        experimental_context: undefined,
        content: [],
        text: '',
        reasoning: [],
        reasoningText: undefined,
        files: [],
        sources: [],
        toolCalls: [],
        staticToolCalls: [],
        dynamicToolCalls: [],
        toolResults: [],
        staticToolResults: [],
        dynamicToolResults: [],
        finishReason: 'stop',
        rawFinishReason: 'stop',
        usage: {
          inputTokens: 1,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokens: 1,
          outputTokenDetails: {
            textTokens: 1,
            reasoningTokens: undefined,
          },
          totalTokens: 2,
        },
        warnings: undefined,
        request: { body: undefined },
        response: {
          id: 'response_a',
          timestamp: new Date(),
          modelId: 'gpt-5',
          headers: {},
          messages: [],
        },
        providerMetadata: undefined,
      } as never);

      await integration.onFinish?.({
        stepNumber: 0,
        model: { provider: 'openai', modelId: 'gpt-5' },
        functionId: 'B',
        metadata: undefined,
        experimental_context: undefined,
        content: [],
        text: '',
        reasoning: [],
        reasoningText: undefined,
        files: [],
        sources: [],
        toolCalls: [],
        staticToolCalls: [],
        dynamicToolCalls: [],
        toolResults: [],
        staticToolResults: [],
        dynamicToolResults: [],
        finishReason: 'stop',
        rawFinishReason: 'stop',
        usage: {
          inputTokens: 1,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokens: 1,
          outputTokenDetails: {
            textTokens: 1,
            reasoningTokens: undefined,
          },
          totalTokens: 2,
        },
        warnings: undefined,
        request: { body: undefined },
        response: {
          id: 'response_b',
          timestamp: new Date(),
          modelId: 'gpt-5',
          headers: {},
          messages: [],
        },
        providerMetadata: undefined,
        steps: [],
        totalUsage: {
          inputTokens: 1,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokens: 1,
          outputTokenDetails: {
            textTokens: 1,
            reasoningTokens: undefined,
          },
          totalTokens: 2,
        },
      } as never);

      await integration.onFinish?.({
        stepNumber: 0,
        model: { provider: 'openai', modelId: 'gpt-5' },
        functionId: 'A',
        metadata: undefined,
        experimental_context: undefined,
        content: [],
        text: '',
        reasoning: [],
        reasoningText: undefined,
        files: [],
        sources: [],
        toolCalls: [],
        staticToolCalls: [],
        dynamicToolCalls: [],
        toolResults: [],
        staticToolResults: [],
        dynamicToolResults: [],
        finishReason: 'stop',
        rawFinishReason: 'stop',
        usage: {
          inputTokens: 1,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokens: 1,
          outputTokenDetails: {
            textTokens: 1,
            reasoningTokens: undefined,
          },
          totalTokens: 2,
        },
        warnings: undefined,
        request: { body: undefined },
        response: {
          id: 'response_a',
          timestamp: new Date(),
          modelId: 'gpt-5',
          headers: {},
          messages: [],
        },
        providerMetadata: undefined,
        steps: [],
        totalUsage: {
          inputTokens: 1,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokens: 1,
          outputTokenDetails: {
            textTokens: 1,
            reasoningTokens: undefined,
          },
          totalTokens: 2,
        },
      } as never);

      const traceForA = exported
        .map(
          (batch) =>
            batch.find((item) => item.object === 'trace') as OpenAITrace,
        )
        .find((trace) => trace.workflow_name === 'A');
      assert.ok(traceForA);

      const generationSpanForA = (
        exported
          .flat()
          .filter((item) => item.object === 'trace.span') as OpenAISpan[]
      ).find(
        (span) =>
          span.trace_id === traceForA.id &&
          span.span_data.type === 'generation',
      );
      assert.ok(generationSpanForA);
      assert.strictEqual(generationSpanForA.trace_id, traceForA.id);
    });

    it('captures multi-step runs with one generation span per step', async () => {
      const { streamText, tool } = await import('ai');
      const { z } = await import('zod');
      const { exporter, exported } = createMockExporter();

      const integration = createOpenAITracesIntegration({
        workflowName: 'two-step-workflow',
        exporter,
      });

      const result = streamText({
        model: createTwoStepToolModel(),
        prompt: 'Weather in London?',
        tools: {
          get_weather: tool({
            description: 'Get weather',
            inputSchema: z.object({ city: z.string() }),
            execute: async ({ city }: { city: string }) => ({ temp: 15, city }),
          }),
        },
        stopWhen: stepCountIs(2),
        experimental_telemetry: {
          isEnabled: true,
          integrations: [integration],
        },
      });

      for await (const _chunk of result.textStream) {
        // consume stream
      }

      await result.response;
      await flushTelemetry();

      assert.strictEqual(exported.length, 1);
      const items = exported[0];
      const trace = items.find(
        (item) => item.object === 'trace',
      ) as OpenAITrace;
      assert.strictEqual(trace.metadata?.steps, 2);

      const generationSpans = (
        items.filter((item) => item.object === 'trace.span') as OpenAISpan[]
      ).filter((span) => span.span_data.type === 'generation');
      assert.strictEqual(generationSpans.length, 2);

      for (const span of generationSpans) {
        assert.ok(span.ended_at, 'generation spans should be closed');
      }
    });

    it('produces function spans for tool calls', async () => {
      const { streamText, tool } = await import('ai');
      const { z } = await import('zod');
      const { exporter, exported } = createMockExporter();

      const integration = createOpenAITracesIntegration({
        workflowName: 'tool-workflow',
        exporter,
      });

      const result = streamText({
        model: createTwoStepToolModel(),
        prompt: 'Weather in London?',
        tools: {
          get_weather: tool({
            description: 'Get weather',
            inputSchema: z.object({ city: z.string() }),
            execute: async ({ city }: { city: string }) => ({ temp: 15, city }),
          }),
        },
        stopWhen: stepCountIs(2),
        experimental_telemetry: {
          isEnabled: true,
          integrations: [integration],
        },
      });

      for await (const _chunk of result.textStream) {
        // consume
      }

      await result.response;
      await flushTelemetry();

      assert.strictEqual(exported.length, 1);
      const items = exported[0];

      const functionSpans = (
        items.filter((item) => item.object === 'trace.span') as OpenAISpan[]
      ).filter((span) => span.span_data.type === 'function');
      assert.ok(
        functionSpans.length >= 1,
        `expected at least 1 function span, got ${functionSpans.length}`,
      );

      const functionSpan = functionSpans[0];
      assert.strictEqual(
        (functionSpan.span_data as { name: string }).name,
        'get_weather',
      );
      assert.ok(functionSpan.ended_at, 'function span should be closed');
      assert.deepStrictEqual(
        (functionSpan.span_data as { output: unknown }).output,
        {
          temp: 15,
          city: 'London',
        },
      );
    });

    it('records tool failures using span error data', async () => {
      const { exporter, exported } = createMockExporter();
      const integration = createOpenAITracesIntegration({
        workflowName: 'failing-tool-workflow',
        exporter,
      });

      await integration.onStart?.({
        model: { provider: 'openai', modelId: 'gpt-5' },
        system: undefined,
        prompt: 'Run a tool',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Run a tool' }] },
        ],
        tools: undefined,
        toolChoice: undefined,
        activeTools: undefined,
        maxOutputTokens: undefined,
        temperature: undefined,
        topP: undefined,
        topK: undefined,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stopSequences: undefined,
        seed: undefined,
        maxRetries: 0,
        timeout: undefined,
        headers: undefined,
        providerOptions: undefined,
        stopWhen: undefined,
        output: undefined,
        abortSignal: undefined,
        include: undefined,
        functionId: 'failing-tool',
        metadata: undefined,
        experimental_context: undefined,
      });

      await integration.onStepStart?.({
        stepNumber: 0,
        model: { provider: 'openai', modelId: 'gpt-5' },
        system: undefined,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Run a tool' }] },
        ],
        tools: undefined,
        toolChoice: undefined,
        activeTools: undefined,
        steps: [],
        providerOptions: undefined,
        timeout: undefined,
        headers: undefined,
        stopWhen: undefined,
        output: undefined,
        abortSignal: undefined,
        include: undefined,
        functionId: 'failing-tool',
        metadata: undefined,
        experimental_context: undefined,
      });

      await integration.onToolCallStart?.({
        stepNumber: 0,
        model: { provider: 'openai', modelId: 'gpt-5' },
        toolCall: {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'explode',
          input: { id: 1 },
          providerExecuted: false,
          dynamic: false,
        },
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Run a tool' }] },
        ],
        abortSignal: undefined,
        functionId: 'failing-tool',
        metadata: undefined,
        experimental_context: undefined,
      } as never);

      await integration.onToolCallFinish?.({
        stepNumber: 0,
        model: { provider: 'openai', modelId: 'gpt-5' },
        toolCall: {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'explode',
          input: { id: 1 },
          providerExecuted: false,
          dynamic: false,
        },
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Run a tool' }] },
        ],
        abortSignal: undefined,
        durationMs: 5,
        functionId: 'failing-tool',
        metadata: undefined,
        experimental_context: undefined,
        success: false,
        error: new Error('boom'),
      } as never);

      await integration.onStepFinish?.({
        stepNumber: 0,
        model: { provider: 'openai', modelId: 'gpt-5' },
        functionId: 'failing-tool',
        metadata: undefined,
        experimental_context: undefined,
        content: [],
        text: '',
        reasoning: [],
        reasoningText: undefined,
        files: [],
        sources: [],
        toolCalls: [],
        staticToolCalls: [],
        dynamicToolCalls: [],
        toolResults: [],
        staticToolResults: [],
        dynamicToolResults: [],
        finishReason: 'tool-calls',
        rawFinishReason: 'tool-calls',
        usage: {
          inputTokens: 1,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokens: 1,
          outputTokenDetails: {
            textTokens: 1,
            reasoningTokens: undefined,
          },
          totalTokens: 2,
        },
        warnings: undefined,
        request: { body: undefined },
        response: {
          id: 'response_1',
          timestamp: new Date(),
          modelId: 'gpt-5',
          headers: {},
          messages: [],
        },
        providerMetadata: undefined,
      } as never);

      await integration.onFinish?.({
        stepNumber: 0,
        model: { provider: 'openai', modelId: 'gpt-5' },
        functionId: 'failing-tool',
        metadata: undefined,
        experimental_context: undefined,
        content: [],
        text: '',
        reasoning: [],
        reasoningText: undefined,
        files: [],
        sources: [],
        toolCalls: [],
        staticToolCalls: [],
        dynamicToolCalls: [],
        toolResults: [],
        staticToolResults: [],
        dynamicToolResults: [],
        finishReason: 'stop',
        rawFinishReason: 'stop',
        usage: {
          inputTokens: 1,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokens: 1,
          outputTokenDetails: {
            textTokens: 1,
            reasoningTokens: undefined,
          },
          totalTokens: 2,
        },
        warnings: undefined,
        request: { body: undefined },
        response: {
          id: 'response_1',
          timestamp: new Date(),
          modelId: 'gpt-5',
          headers: {},
          messages: [],
        },
        providerMetadata: undefined,
        steps: [],
        totalUsage: {
          inputTokens: 1,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokens: 1,
          outputTokenDetails: {
            textTokens: 1,
            reasoningTokens: undefined,
          },
          totalTokens: 2,
        },
      } as never);

      await flushTelemetry();

      const functionSpan = (
        exported[0].filter(
          (item) => item.object === 'trace.span',
        ) as OpenAISpan[]
      ).find((span) => span.span_data.type === 'function');
      assert.ok(functionSpan);
      assert.deepStrictEqual(functionSpan.error, {
        message: 'boom',
        data: {
          name: 'Error',
          stack: functionSpan.error?.data?.stack,
        },
      });
    });

    it('respects includeSensitiveData=false for generation and function spans', async () => {
      const { streamText, tool } = await import('ai');
      const { z } = await import('zod');
      const { exporter, exported } = createMockExporter();

      const integration = createOpenAITracesIntegration({
        workflowName: 'private-workflow',
        exporter,
        includeSensitiveData: false,
      });

      const result = streamText({
        model: createTwoStepToolModel(),
        prompt: 'Secret data',
        tools: {
          get_weather: tool({
            description: 'Get weather',
            inputSchema: z.object({ city: z.string() }),
            execute: async ({ city }: { city: string }) => ({ temp: 15, city }),
          }),
        },
        stopWhen: stepCountIs(2),
        experimental_telemetry: {
          isEnabled: true,
          integrations: [integration],
        },
      });

      for await (const _chunk of result.textStream) {
        // consume
      }

      await result.response;
      await flushTelemetry();

      const items = exported[0];
      const spans = items.filter(
        (item) => item.object === 'trace.span',
      ) as OpenAISpan[];

      const generationSpan = spans.find(
        (span) => span.span_data.type === 'generation',
      );
      assert.ok(generationSpan);
      assert.strictEqual(
        (generationSpan.span_data as { input?: unknown }).input,
        undefined,
        'generation input should not be recorded',
      );
      assert.strictEqual(
        (generationSpan.span_data as { output?: unknown }).output,
        undefined,
        'generation output should not be recorded',
      );

      const functionSpan = spans.find(
        (span) => span.span_data.type === 'function',
      );
      assert.ok(functionSpan);
      assert.strictEqual(
        (functionSpan.span_data as { input?: unknown }).input,
        undefined,
        'function input should not be recorded',
      );
      assert.strictEqual(
        (functionSpan.span_data as { output?: unknown }).output,
        undefined,
        'function output should not be recorded',
      );
    });
  });

  describe('BatchTraceProcessor', () => {
    it('batches completed traces and spans before exporting', async () => {
      const exported: TraceItem[][] = [];
      const exporter: TracingExporter = {
        async export(items) {
          exported.push(structuredClone(items));
        },
      };

      const processor = new BatchTraceProcessor(exporter, {
        maxBatchSize: 2,
        maxQueueSize: 10,
        scheduleDelayMs: 60_000,
      });

      await processor.onSpanEnd?.({
        object: 'trace.span',
        id: 'span_1',
        trace_id: 'trace_1',
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        span_data: { type: 'agent', name: 'workflow' },
      });
      await processor.onSpanEnd?.({
        object: 'trace.span',
        id: 'span_2',
        trace_id: 'trace_1',
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        span_data: { type: 'generation' },
      });
      await processor.onTraceEnd?.({
        object: 'trace',
        id: 'trace_1',
        workflow_name: 'workflow',
      });

      await processor.forceFlush?.();

      assert.strictEqual(exported.length, 2);
      assert.deepStrictEqual(
        exported[0].map((item) => item.id),
        ['span_1', 'span_2'],
      );
      assert.deepStrictEqual(exported[1], [
        {
          object: 'trace',
          id: 'trace_1',
          workflow_name: 'workflow',
        },
      ]);
    });

    it('retains failed batches so a later flush can retry them', async () => {
      let attempts = 0;
      const exported: TraceItem[][] = [];
      const exporter: TracingExporter = {
        async export(items) {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('fail once');
          }
          exported.push(structuredClone(items));
        },
      };

      const processor = new BatchTraceProcessor(exporter, {
        maxBatchSize: 2,
        maxQueueSize: 10,
        scheduleDelayMs: 60_000,
      });

      await processor.onSpanEnd?.({
        object: 'trace.span',
        id: 'span_1',
        trace_id: 'trace_1',
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        span_data: { type: 'agent', name: 'workflow' },
      });
      await processor.onSpanEnd?.({
        object: 'trace.span',
        id: 'span_2',
        trace_id: 'trace_1',
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        span_data: { type: 'generation' },
      });
      await processor.onTraceEnd?.({
        object: 'trace',
        id: 'trace_1',
        workflow_name: 'workflow',
      });

      await assert.rejects(() => processor.forceFlush?.(), /fail once/);
      await processor.forceFlush?.();

      assert.deepStrictEqual(
        exported.map((batch) => batch.map((item) => item.id)),
        [['span_1', 'span_2'], ['trace_1']],
      );
    });
  });

  describe('OpenAITracesExporter', () => {
    it('throws on missing API key', async () => {
      const original = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      try {
        const exporter = new OpenAITracesExporter({ apiKey: '' });
        await assert.rejects(
          () =>
            exporter.export([
              {
                object: 'trace',
                id: 'trace_abc',
                workflow_name: 'test',
              },
            ]),
          /API key is required/,
        );
      } finally {
        if (original) process.env.OPENAI_API_KEY = original;
      }
    });

    it('skips export for empty items', async () => {
      const exporter = new OpenAITracesExporter({ apiKey: 'test' });
      await exporter.export([]);
    });
  });

  describe('ID generators', () => {
    it('generates correct trace ID format', async () => {
      const { groupId, spanId, traceId } =
        await import('@deepagents/context/tracing');

      const tid = traceId();
      assert.ok(tid.startsWith('trace_'));
      assert.strictEqual(tid.length, 38);

      const sid = spanId();
      assert.ok(sid.startsWith('span_'));
      assert.strictEqual(sid.length, 29);

      const gid = groupId();
      assert.ok(gid.startsWith('group_'));
      assert.strictEqual(gid.length, 30);
    });
  });
});
