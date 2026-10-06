import {
  NoObjectGeneratedError,
  type Telemetry,
  embed,
  generateObject,
  generateText,
  isStepCount,
  rerank,
  streamText,
  tool,
} from 'ai';
import {
  MockEmbeddingModelV4,
  MockLanguageModelV4,
  MockRerankingModelV4,
  convertArrayToReadableStream,
} from 'ai/test';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { createConsoleTelemetry } from '@deepagents/context/telemetry';

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} as const;

const telemetryRecord = z.object({
  timestamp: z.string(),
  event: z.string(),
  data: z.unknown(),
});

const objectTelemetryRecord = telemetryRecord.extend({
  data: z.record(z.string(), z.unknown()),
});

const toolCallInput = z.object({
  toolCall: z.object({ input: z.unknown() }),
});

const toolOutputValue = z.object({
  toolOutput: z.object({ output: z.unknown() }),
});

function parseRecord(line: string) {
  return telemetryRecord.parse(JSON.parse(line));
}

function textModel(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    },
  });
}

/**
 * Runs real AI SDK operations that, together, fire every telemetry callback:
 * a two-step generateText with a tool call, generateObject, embed, rerank, a
 * streamText aborted before it starts, and a generateText whose model fails.
 */
async function triggerEveryTelemetryCallback(
  telemetry: Telemetry,
): Promise<void> {
  await generateText({
    model: new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'echo-call',
              toolName: 'echo',
              input: JSON.stringify({ text: 'tool input' }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        },
        {
          content: [{ type: 'text', text: 'final answer' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        },
      ],
    }),
    prompt: 'use the tool',
    tools: {
      echo: tool({
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => ({ echoed: text }),
      }),
    },
    stopWhen: isStepCount(2),
    telemetry: { integrations: telemetry },
  });
  await generateObject({
    model: textModel('{"value":"object"}'),
    schema: z.object({ value: z.string() }),
    prompt: 'make an object',
    telemetry: { integrations: telemetry },
  });
  await embed({
    model: new MockEmbeddingModelV4({
      doEmbed: { embeddings: [[0.1, 0.2]], warnings: [] },
    }),
    value: 'embed me',
    telemetry: { integrations: telemetry },
  });
  await rerank({
    model: new MockRerankingModelV4({
      doRerank: async () => ({
        ranking: [{ index: 0, relevanceScore: 0.9 }],
      }),
    }),
    documents: ['only document'],
    query: 'rank me',
    telemetry: { integrations: telemetry },
  });
  await streamText({
    model: new MockLanguageModelV4({
      doStream: {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
        ]),
      },
    }),
    prompt: 'aborted before it starts',
    abortSignal: AbortSignal.abort(),
    telemetry: { integrations: telemetry },
  }).consumeStream();
  await assert.rejects(
    generateText({
      model: new MockLanguageModelV4({
        doGenerate: () => Promise.reject(new Error('model failure')),
      }),
      prompt: 'fail',
      maxRetries: 0,
      telemetry: { integrations: telemetry },
    }),
    { message: 'model failure' },
  );
}

describe('createConsoleTelemetry()', () => {
  it('logs the timestamped generateText lifecycle with inputs and outputs', async (t) => {
    const timestamp = '2026-07-12T10:00:00.000Z';
    t.mock.timers.enable({ apis: ['Date'] });
    t.mock.timers.setTime(Date.parse(timestamp));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const telemetry = createConsoleTelemetry({
      pretty: false,
      logger: {
        log: (value) => stdout.push(String(value)),
        error: (value) => stderr.push(String(value)),
      },
    });
    const model = new MockLanguageModelV4({
      provider: 'test-provider',
      modelId: 'test-model',
      doGenerate: {
        content: [{ type: 'text', text: 'hello back' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      },
    });

    await generateText({
      model,
      prompt: 'hello there',
      telemetry: { integrations: telemetry },
    });

    const records = stdout.map(parseRecord);
    assert.deepStrictEqual(
      [...new Set(records.map((record) => record.timestamp))],
      [timestamp],
    );
    assert.deepStrictEqual(
      records.map(({ event }) => event),
      [
        'onStart',
        'onStepStart',
        'onLanguageModelCallStart',
        'onLanguageModelCallEnd',
        'onStepEnd',
        'onEnd',
      ],
    );
    assert.match(JSON.stringify(records), /hello there/);
    assert.match(JSON.stringify(records), /hello back/);
    assert.deepStrictEqual(stderr, []);
  });

  it('logs tool execution inputs and outputs', async () => {
    const output: string[] = [];
    const telemetry = createConsoleTelemetry({
      pretty: false,
      logger: {
        log: (value) => output.push(String(value)),
        error: (value) => output.push(String(value)),
      },
    });
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'echo-call',
              toolName: 'echo',
              input: JSON.stringify({ text: 'tool input' }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        },
        {
          content: [{ type: 'text', text: 'final answer' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        },
      ],
    });

    await generateText({
      model,
      prompt: 'use the tool',
      tools: {
        echo: tool({
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => ({ echoed: text }),
        }),
      },
      stopWhen: isStepCount(2),
      telemetry: { integrations: telemetry },
    });

    const records = output.map(parseRecord);
    assert.deepStrictEqual(
      records
        .map(({ event }) => event)
        .filter((event) => event.includes('Tool')),
      ['onToolExecutionStart', 'onToolExecutionEnd'],
    );
    assert.match(JSON.stringify(records), /tool input/);
    assert.match(JSON.stringify(records), /echoed/);
  });

  it('honors AI SDK input and output recording opt-outs for generations and tools', async () => {
    const capture = async (recordInputs: boolean, recordOutputs: boolean) => {
      const output: string[] = [];
      const telemetry = createConsoleTelemetry({
        pretty: false,
        logger: {
          log: (value) => output.push(String(value)),
          error: (value) => output.push(String(value)),
        },
      });
      const model = new MockLanguageModelV4({
        doGenerate: [
          {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'private-call',
                toolName: 'privateTool',
                input: JSON.stringify({ secret: 'SECRET_TOOL_INPUT' }),
              },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage,
            warnings: [],
          },
          {
            content: [{ type: 'text', text: 'SECRET_MODEL_OUTPUT' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage,
            warnings: [],
          },
        ],
      });

      await generateText({
        model,
        prompt: 'SECRET_MODEL_INPUT',
        tools: {
          privateTool: tool({
            inputSchema: z.object({ secret: z.string() }),
            execute: async () => ({ secret: 'SECRET_TOOL_OUTPUT' }),
          }),
        },
        stopWhen: isStepCount(2),
        telemetry: { integrations: telemetry, recordInputs, recordOutputs },
      });
      return {
        serialized: output.join('\n'),
        records: output.map(parseRecord),
      };
    };

    const withoutInputs = await capture(false, true);
    assert.doesNotMatch(withoutInputs.serialized, /SECRET_MODEL_INPUT/);
    assert.match(withoutInputs.serialized, /SECRET_MODEL_OUTPUT/);
    assert.match(withoutInputs.serialized, /SECRET_TOOL_OUTPUT/);
    const toolStart = withoutInputs.records.find(
      ({ event }) => event === 'onToolExecutionStart',
    );
    assert.strictEqual(
      toolCallInput.parse(toolStart?.data).toolCall.input,
      '[Redacted]',
    );

    const withoutOutputs = await capture(true, false);
    assert.match(withoutOutputs.serialized, /SECRET_MODEL_INPUT/);
    assert.doesNotMatch(withoutOutputs.serialized, /SECRET_MODEL_OUTPUT/);
    const toolEnd = withoutOutputs.records.find(
      ({ event }) => event === 'onToolExecutionEnd',
    );
    assert.strictEqual(
      toolOutputValue.parse(toolEnd?.data).toolOutput.output,
      '[Redacted]',
    );
  });

  it('redacts embedding and structured-object payloads without fabricating fields', async () => {
    const output: string[] = [];
    const telemetry = createConsoleTelemetry({
      pretty: false,
      logger: {
        log: (value) => output.push(String(value)),
        error: (value) => output.push(String(value)),
      },
    });

    await embed({
      model: new MockEmbeddingModelV4({
        doEmbed: { embeddings: [[0.1, 0.2]], warnings: [] },
      }),
      value: 'SECRET_EMBED_INPUT',
      telemetry: {
        integrations: telemetry,
        recordInputs: false,
        recordOutputs: false,
      },
    });
    await generateObject({
      model: textModel('{"value":"public object"}'),
      schema: z.object({ value: z.string().describe('SECRET_OBJECT_SCHEMA') }),
      schemaName: 'SECRET_SCHEMA_NAME',
      schemaDescription: 'SECRET_SCHEMA_DESCRIPTION',
      instructions: 'SECRET_OBJECT_SYSTEM',
      prompt: 'SECRET_OBJECT_PROMPT',
      telemetry: { integrations: telemetry, recordInputs: false },
    });
    await assert.rejects(
      generateObject({
        model: textModel('SECRET_INVALID_OBJECT_OUTPUT'),
        schema: z.object({ value: z.string() }),
        prompt: 'produce an object',
        telemetry: { integrations: telemetry, recordOutputs: false },
      }),
      (error) => NoObjectGeneratedError.isInstance(error),
    );

    const records = output.map((line) =>
      objectTelemetryRecord.parse(JSON.parse(line)),
    );
    const serialized = output.join('\n');
    assert.doesNotMatch(serialized, /SECRET_/);
    assert.match(serialized, /\[Redacted\]/);
    assert.deepStrictEqual(
      records.map(({ event }) => event),
      [
        'onStart',
        'onEmbedStart',
        'onEmbedEnd',
        'onEnd',
        'onStart',
        'onObjectStepStart',
        'onObjectStepEnd',
        'onEnd',
        'onStart',
        'onObjectStepStart',
        'onObjectStepEnd',
        'onError',
      ],
    );
    for (const { data } of records) {
      assert.strictEqual(Object.hasOwn(data, 'toolCall'), false);
      assert.strictEqual(Object.hasOwn(data, 'toolOutput'), false);
      assert.strictEqual(Object.hasOwn(data, 'steps'), false);
      assert.strictEqual(Object.hasOwn(data, 'finalStep'), false);
    }
  });

  it('never lets logger failures break model execution', async () => {
    const telemetry = createConsoleTelemetry({
      logger: {
        log: () => {
          throw new Error('broken console');
        },
        error: () => {
          throw new Error('broken console');
        },
      },
    });
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'text', text: 'still succeeds' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      },
    });

    const result = await generateText({
      model,
      prompt: 'hello',
      telemetry: { integrations: telemetry },
    });

    assert.strictEqual(result.text, 'still succeeds');
    assert.strictEqual(model.doGenerateCalls.length, 1);
  });

  it('safely logs errors and values that JSON cannot normally serialize', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const telemetry = createConsoleTelemetry({
      pretty: false,
      logger: {
        log: (value) => stdout.push(String(value)),
        error: (value) => stderr.push(String(value)),
      },
    });
    const circular: Record<string, unknown> = { label: 'root' };
    circular.self = circular;
    const cause = new Error('inner failure');
    const error = new Error('outer failure', { cause });
    Object.assign(error, { code: 'E_OUTER' });

    await telemetry.onError?.({
      error,
      circular,
      bigint: 42n,
      missing: undefined,
      callback: function namedCallback() {},
      marker: Symbol('marker'),
    });

    assert.deepStrictEqual(stdout, []);
    assert.strictEqual(stderr.length, 1);
    const record = objectTelemetryRecord.parse(JSON.parse(stderr[0]));
    assert.strictEqual(record.event, 'onError');
    assert.deepStrictEqual(record.data.error, {
      name: 'Error',
      message: 'outer failure',
      stack: error.stack,
      cause: {
        name: 'Error',
        message: 'inner failure',
        stack: cause.stack,
      },
      code: 'E_OUTER',
    });
    assert.deepStrictEqual(record.data.circular, {
      label: 'root',
      self: '[Circular]',
    });
    assert.strictEqual(record.data.bigint, '42n');
    assert.strictEqual(record.data.missing, '[Undefined]');
    assert.strictEqual(record.data.callback, '[Function namedCallback]');
    assert.strictEqual(record.data.marker, 'Symbol(marker)');
  });

  it('preserves own __proto__ fields without prototype pollution', async () => {
    const errors: string[] = [];
    const telemetry = createConsoleTelemetry({
      pretty: false,
      logger: {
        log: () => {},
        error: (value) => errors.push(String(value)),
      },
    });
    const payload: unknown = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"kept"}',
    );

    await telemetry.onError?.(payload);

    // `data: z.unknown()` hands back JSON.parse's object untouched, so its
    // own `__proto__` key survives parsing.
    const record = parseRecord(errors[0]);
    assert.deepStrictEqual(record.data, payload);
    assert.strictEqual(Object.hasOwn(Object.prototype, 'polluted'), false);
  });

  it('covers every AI SDK telemetry lifecycle callback without duplicate step logs', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const telemetry = createConsoleTelemetry({
      pretty: false,
      logger: {
        log: (value) => output.push(String(value)),
        error: (value) => errors.push(String(value)),
      },
    });
    const callbackNames = [
      'onStart',
      'onStepStart',
      'onLanguageModelCallStart',
      'onLanguageModelCallEnd',
      'onToolExecutionStart',
      'onToolExecutionEnd',
      'onStepEnd',
      'onObjectStepStart',
      'onObjectStepEnd',
      'onEmbedStart',
      'onEmbedEnd',
      'onRerankStart',
      'onRerankEnd',
      'onEnd',
      'onAbort',
    ] as const satisfies readonly (keyof Telemetry)[];

    await triggerEveryTelemetryCallback(telemetry);

    assert.deepStrictEqual(
      new Set(output.map((line) => parseRecord(line).event)),
      new Set(callbackNames),
    );
    assert.deepStrictEqual(
      errors.map((line) => parseRecord(line).event),
      ['onError'],
    );
    assert.strictEqual(telemetry.onStepFinish, undefined);
  });
});
