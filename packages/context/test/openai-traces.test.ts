import { simulateReadableStream, stepCountIs } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import nock from 'nock';
import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  BatchTraceProcessor,
  type OpenAISpan,
  type OpenAITrace,
  OpenAITracesExporter,
  type SpanData,
  type TraceItem,
  type TracingExporter,
  createOpenAITracesIntegration,
} from '@deepagents/context/tracing';

interface IngestBody {
  data: TraceItem[];
}

function captureIngestRequests() {
  const captured: IngestBody[] = [];
  nock('https://api.openai.com')
    .persist()
    .post('/v1/traces/ingest', (body) => {
      captured.push(body as IngestBody);
      return true;
    })
    .reply(200, { ok: true });
  return captured;
}

function spansOfType(body: IngestBody, type: string): OpenAISpan[] {
  return body.data.filter(
    (item) =>
      item.object === 'trace.span' &&
      (item.span_data as { type?: string } | undefined)?.type === type,
  ) as OpenAISpan[];
}

type WireShape = 'array' | 'string' | 'object';

interface WireRule {
  input?: WireShape;
  output?: WireShape;
  usageKeys?: readonly string[];
}

const WIRE_RULES: Record<SpanData['type'], WireRule> = {
  agent: {},
  handoff: {},
  guardrail: {},
  custom: {},
  response: {},
  mcp_list_tools: {},
  speech_group: {},
  generation: {
    input: 'array',
    output: 'array',
    usageKeys: ['input_tokens', 'output_tokens', 'details'],
  },
  function: { input: 'string', output: 'string' },
  transcription: { input: 'string', output: 'string' },
  speech: { input: 'object', output: 'object' },
};

function matchesShape(value: unknown, shape: WireShape): boolean {
  if (shape === 'array') return Array.isArray(value);
  if (shape === 'string') return typeof value === 'string';
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertWireSchema(spans: OpenAISpan[]): string[] {
  const violations: string[] = [];
  for (const span of spans) {
    const type = span.span_data.type;
    const rule = WIRE_RULES[type];
    const data = span.span_data as {
      input?: unknown;
      output?: unknown;
      usage?: Record<string, unknown>;
    };

    if (rule.input && data.input !== undefined) {
      if (!matchesShape(data.input, rule.input)) {
        violations.push(
          `${type} span ${span.id}: input is ${typeof data.input}${
            Array.isArray(data.input) ? ' (array)' : ''
          }, expected ${rule.input}`,
        );
      }
    }
    if (rule.output && data.output !== undefined) {
      if (!matchesShape(data.output, rule.output)) {
        violations.push(
          `${type} span ${span.id}: output is ${typeof data.output}${
            Array.isArray(data.output) ? ' (array)' : ''
          }, expected ${rule.output}`,
        );
      }
    }
    if (rule.usageKeys && data.usage != null) {
      const allowed = new Set(rule.usageKeys);
      for (const key of Object.keys(data.usage)) {
        if (!allowed.has(key)) {
          violations.push(
            `${type} span ${span.id}: usage has unknown key '${key}' (OpenAI would reject it as unknown_parameter)`,
          );
        }
      }
    }
  }
  return violations;
}

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

async function flushTelemetry() {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

beforeEach(() => {
  nock.cleanAll();
});

afterEach(() => {
  nock.cleanAll();
});

describe('OpenAI Traces Integration', () => {
  describe('createOpenAITracesIntegration', () => {
    it('produces correct trace and spans for a simple streamText call', async () => {
      const { streamText } = await import('ai');
      const captured = captureIngestRequests();

      const integration = createOpenAITracesIntegration({
        apiKey: 'test-key',
        workflowName: 'test-workflow',
        groupId: 'group-123',
        metadata: { env: 'test' },
        batch: { scheduleDelayMs: 60_000 },
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

      assert.strictEqual(captured.length, 1, 'should have exported once');
      const items = captured[0].data;

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
      const genInput = (generationSpan.span_data as { input?: unknown }).input;
      const genOutput = (generationSpan.span_data as { output?: unknown })
        .output;
      assert.ok(
        Array.isArray(genInput),
        'generation input must be an array of message objects on the wire',
      );
      assert.ok(
        Array.isArray(genOutput),
        'generation output must be an array of message objects on the wire',
      );
    });

    it('can be reused without leaking trace state between runs', async () => {
      const { streamText } = await import('ai');
      const captured = captureIngestRequests();

      const integration = createOpenAITracesIntegration({
        apiKey: 'test-key',
        workflowName: 'reused-workflow',
        batch: { scheduleDelayMs: 60_000 },
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

      assert.strictEqual(captured.length, 2);

      const firstTrace = captured[0].data.find(
        (item) => item.object === 'trace',
      ) as OpenAITrace;
      const secondTrace = captured[1].data.find(
        (item) => item.object === 'trace',
      ) as OpenAITrace;
      assert.notStrictEqual(firstTrace.id, secondTrace.id);
      assert.strictEqual(
        captured[1].data.filter((item) => item.object === 'trace').length,
        1,
        'each export should only contain its own trace',
      );
    });

    it('supports overlapping runs on the same integration instance', async () => {
      const { streamText } = await import('ai');
      const captured = captureIngestRequests();

      const integration = createOpenAITracesIntegration({
        apiKey: 'test-key',
        workflowName: 'concurrent-workflow',
        batch: { scheduleDelayMs: 60_000 },
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

      const allItems = captured.flatMap((body) => body.data);
      const traces = allItems.filter(
        (item) => item.object === 'trace',
      ) as OpenAITrace[];
      assert.strictEqual(traces.length, 2, 'both runs should emit a trace');
      assert.strictEqual(
        new Set(traces.map((t) => t.id)).size,
        2,
        'trace IDs must be distinct across concurrent runs',
      );

      for (const trace of traces) {
        const spansForTrace = (
          allItems.filter(
            (item) => item.object === 'trace.span',
          ) as OpenAISpan[]
        ).filter((span) => span.trace_id === trace.id);
        assert.ok(
          spansForTrace.length >= 1,
          `trace ${trace.id} should have its own spans`,
        );
      }
    });

    it('matches interleaved callbacks by event identity instead of stack order', async () => {
      const captured = captureIngestRequests();
      const integration = createOpenAITracesIntegration({
        apiKey: 'test-key',
        batch: { scheduleDelayMs: 60_000 },
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

      const traceForA = captured
        .map(
          (body) =>
            body.data.find((item) => item.object === 'trace') as OpenAITrace,
        )
        .find((trace) => trace?.workflow_name === 'A');
      assert.ok(traceForA);

      const generationSpanForA = (
        captured
          .flatMap((body) => body.data)
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
      const captured = captureIngestRequests();

      const integration = createOpenAITracesIntegration({
        apiKey: 'test-key',
        workflowName: 'two-step-workflow',
        batch: { scheduleDelayMs: 60_000 },
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

      assert.strictEqual(captured.length, 1);
      const items = captured[0].data;
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
      const captured = captureIngestRequests();

      const integration = createOpenAITracesIntegration({
        apiKey: 'test-key',
        workflowName: 'tool-workflow',
        batch: { scheduleDelayMs: 60_000 },
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

      assert.strictEqual(captured.length, 1);
      const items = captured[0].data;

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
      const fnOutput = (functionSpan.span_data as { output: unknown }).output;
      assert.strictEqual(typeof fnOutput, 'string');
      assert.deepStrictEqual(JSON.parse(fnOutput as string), {
        temp: 15,
        city: 'London',
      });
    });

    it('records tool failures using span error data', async () => {
      const captured = captureIngestRequests();
      const integration = createOpenAITracesIntegration({
        apiKey: 'test-key',
        workflowName: 'failing-tool-workflow',
        batch: { scheduleDelayMs: 60_000 },
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
        captured[0].data.filter(
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
      const captured = captureIngestRequests();

      const integration = createOpenAITracesIntegration({
        apiKey: 'test-key',
        workflowName: 'private-workflow',
        includeSensitiveData: false,
        batch: { scheduleDelayMs: 60_000 },
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

      const items = captured[0].data;
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

describe('OpenAI Traces wire format', () => {
  it('sends generation span input as an array of message objects on the wire', async () => {
    const { streamText } = await import('ai');
    const captured = captureIngestRequests();

    const integration = createOpenAITracesIntegration({
      apiKey: 'test-key',
      workflowName: 'wire-test',
      batch: { scheduleDelayMs: 60_000 },
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
      // consume
    }
    await result.response;
    await flushTelemetry();

    assert.ok(captured.length >= 1, 'should have posted to /v1/traces/ingest');
    const [genSpan] = spansOfType(captured[0], 'generation');
    assert.ok(genSpan, 'expected a generation span in the exported body');

    const input = (genSpan.span_data as { input?: unknown }).input;
    assert.ok(
      Array.isArray(input),
      `span_data.input must be an array of message objects, got ${typeof input}`,
    );
    assert.ok(
      input.every((item) => item != null && typeof item === 'object'),
      'every element of span_data.input must be an object (matches OpenAI traces schema)',
    );
  });

  it('sends generation span output as an array of message objects on the wire', async () => {
    const { streamText } = await import('ai');
    const captured = captureIngestRequests();

    const integration = createOpenAITracesIntegration({
      apiKey: 'test-key',
      workflowName: 'wire-test',
      batch: { scheduleDelayMs: 60_000 },
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
      // consume
    }
    await result.response;
    await flushTelemetry();

    const [genSpan] = spansOfType(captured[0], 'generation');
    const output = (genSpan.span_data as { output?: unknown }).output;
    assert.ok(
      Array.isArray(output),
      `span_data.output must be an array of message objects, got ${typeof output}`,
    );
    assert.ok(
      output.every((item) => item != null && typeof item === 'object'),
      'every element of span_data.output must be an object',
    );
  });

  it('serializes function span input and output as JSON strings on the wire', async () => {
    const { streamText, tool } = await import('ai');
    const { z } = await import('zod');
    const captured = captureIngestRequests();

    const integration = createOpenAITracesIntegration({
      apiKey: 'test-key',
      workflowName: 'wire-tool-test',
      batch: { scheduleDelayMs: 60_000 },
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

    const [fnSpan] = spansOfType(captured[0], 'function');
    assert.ok(fnSpan, 'expected a function span in the exported body');
    const input = (fnSpan.span_data as { input?: unknown }).input;
    const output = (fnSpan.span_data as { output?: unknown }).output;
    assert.strictEqual(typeof input, 'string', 'function input must be string');
    assert.strictEqual(
      typeof output,
      'string',
      'function output must be string',
    );
    assert.deepStrictEqual(JSON.parse(input as string), { city: 'London' });
    assert.deepStrictEqual(JSON.parse(output as string), {
      temp: 15,
      city: 'London',
    });
  });

  it('does not include total_tokens in generation span_data.usage on the wire', async () => {
    const { streamText } = await import('ai');
    const captured = captureIngestRequests();

    const integration = createOpenAITracesIntegration({
      apiKey: 'test-key',
      workflowName: 'usage-keys',
      batch: { scheduleDelayMs: 60_000 },
    });

    const result = streamText({
      model: createMockModel(),
      prompt: 'Hello',
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

    const [genSpan] = spansOfType(captured[0], 'generation');
    assert.ok(genSpan, 'expected a generation span');
    const usage = (genSpan.span_data as { usage?: Record<string, unknown> })
      .usage;
    assert.ok(usage, 'generation span should include usage');
    assert.ok(
      !('total_tokens' in usage),
      `span_data.usage must not contain total_tokens (OpenAI rejects it as unknown_parameter), got keys: ${Object.keys(usage).join(', ')}`,
    );
  });

  it('omits function span input/output from the wire when their in-memory value is null', async () => {
    const captured = captureIngestRequests();
    const exporter = new OpenAITracesExporter({ apiKey: 'test-key' });

    await exporter.export([
      {
        object: 'trace.span',
        id: 'span_fn_null',
        trace_id: 'trace_fn_null',
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        span_data: {
          type: 'function',
          name: 'no_args_tool',
          input: null,
          output: null,
        },
      },
    ]);

    assert.strictEqual(captured.length, 1);
    const [span] = spansOfType(captured[0], 'function');
    assert.ok(span, 'function span should be on the wire');
    const data = span.span_data as unknown as Record<string, unknown>;
    assert.ok(
      !('input' in data),
      `span_data.input must be omitted for null input, got ${JSON.stringify(data.input)}`,
    );
    assert.ok(
      !('output' in data),
      `span_data.output must be omitted for null output, got ${JSON.stringify(data.output)}`,
    );
  });

  it('stringifies transcription span input and output on the wire', async () => {
    const captured = captureIngestRequests();
    const exporter = new OpenAITracesExporter({ apiKey: 'test-key' });

    await exporter.export([
      {
        object: 'trace.span',
        id: 'span_tx',
        trace_id: 'trace_tx',
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        span_data: {
          type: 'transcription',
          model: 'whisper-1',
          input: { audio_url: 'https://example.com/a.wav' },
          output: { text: 'hello world' },
        },
      },
    ]);

    assert.strictEqual(captured.length, 1);
    const [span] = spansOfType(captured[0], 'transcription');
    assert.ok(span, 'transcription span should be on the wire');
    const input = (span.span_data as { input?: unknown }).input;
    const output = (span.span_data as { output?: unknown }).output;
    assert.strictEqual(
      typeof input,
      'string',
      `transcription span_data.input must be a JSON string per openai-agents spec, got ${typeof input}`,
    );
    assert.strictEqual(
      typeof output,
      'string',
      `transcription span_data.output must be a JSON string per openai-agents spec, got ${typeof output}`,
    );
    assert.deepStrictEqual(JSON.parse(input as string), {
      audio_url: 'https://example.com/a.wav',
    });
    assert.deepStrictEqual(JSON.parse(output as string), {
      text: 'hello world',
    });
  });

  it('validates the full wire schema across generation and function spans in one flow', async () => {
    const { streamText, tool } = await import('ai');
    const { z } = await import('zod');
    const captured = captureIngestRequests();

    const integration = createOpenAITracesIntegration({
      apiKey: 'test-key',
      workflowName: 'wire-schema-full',
      batch: { scheduleDelayMs: 60_000 },
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

    const spans = captured.flatMap((body) =>
      body.data.filter((item) => item.object === 'trace.span'),
    ) as OpenAISpan[];

    const violations = assertWireSchema(spans);
    assert.deepStrictEqual(
      violations,
      [],
      `wire schema violations detected (these would return 400 from OpenAI):\n${violations.join('\n')}`,
    );

    const hasGeneration = spans.some((s) => s.span_data.type === 'generation');
    const hasFunction = spans.some((s) => s.span_data.type === 'function');
    assert.ok(
      hasGeneration && hasFunction,
      'test must exercise both span types',
    );
  });

  it('disambiguates concurrent runs with distinct prompts and no other discriminator', async () => {
    const { streamText } = await import('ai');
    const captured = captureIngestRequests();

    const integration = createOpenAITracesIntegration({
      apiKey: 'test-key',
      workflowName: 'disambiguation-workflow',
      batch: { scheduleDelayMs: 60_000 },
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
        // consume
      }
      await result.response;
    }

    await Promise.all([run('Alpha'), run('Beta')]);
    await flushTelemetry();

    const allItems = captured.flatMap((body) => body.data);
    const traces = allItems.filter(
      (item) => item.object === 'trace',
    ) as OpenAITrace[];
    assert.strictEqual(traces.length, 2, 'each run must emit its own trace');
    assert.strictEqual(
      new Set(traces.map((t) => t.id)).size,
      2,
      'trace ids must be distinct',
    );

    const spans = allItems.filter(
      (item) => item.object === 'trace.span',
    ) as OpenAISpan[];

    const generationByTrace = new Map<string, string>();
    for (const span of spans) {
      if (span.span_data.type !== 'generation') continue;
      const input = (span.span_data as { input?: unknown }).input;
      if (!Array.isArray(input)) continue;
      const firstMessage = input[0] as { content?: unknown } | undefined;
      generationByTrace.set(
        span.trace_id,
        JSON.stringify(firstMessage?.content),
      );
    }

    assert.strictEqual(
      generationByTrace.size,
      2,
      'each trace must own its own generation span',
    );
    const texts = [...generationByTrace.values()].join('|');
    assert.ok(
      texts.includes('Alpha'),
      'one trace should carry the Alpha prompt',
    );
    assert.ok(texts.includes('Beta'), 'one trace should carry the Beta prompt');
  });
});
