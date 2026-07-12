import { type Telemetry, generateText, isStepCount, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { createConsoleTelemetry } from '@deepagents/context/telemetry';

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} as const;

interface CapturedTelemetryRecord {
  event: string;
  data: {
    toolCall?: { input?: unknown };
    toolOutput?: { output?: unknown };
  };
}

describe('createConsoleTelemetry()', () => {
  it('logs the complete generateText lifecycle with inputs and outputs', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const telemetry = createConsoleTelemetry({
      includeTimestamp: false,
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

    const records = stdout.map(
      (line) => JSON.parse(line) as { event: string; data: unknown },
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
      includeTimestamp: false,
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

    const records = output.map(
      (line) => JSON.parse(line) as { event: string; data: unknown },
    );
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
        includeTimestamp: false,
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
        records: output.map(
          (line) => JSON.parse(line) as CapturedTelemetryRecord,
        ),
      };
    };

    const withoutInputs = await capture(false, true);
    assert.doesNotMatch(withoutInputs.serialized, /SECRET_MODEL_INPUT/);
    assert.match(withoutInputs.serialized, /SECRET_MODEL_OUTPUT/);
    assert.match(withoutInputs.serialized, /SECRET_TOOL_OUTPUT/);
    assert.strictEqual(
      withoutInputs.records.find(
        ({ event }) => event === 'onToolExecutionStart',
      )?.data.toolCall?.input,
      '[Redacted]',
    );

    const withoutOutputs = await capture(true, false);
    assert.match(withoutOutputs.serialized, /SECRET_MODEL_INPUT/);
    assert.doesNotMatch(withoutOutputs.serialized, /SECRET_MODEL_OUTPUT/);
    assert.strictEqual(
      withoutOutputs.records.find(({ event }) => event === 'onToolExecutionEnd')
        ?.data.toolOutput?.output,
      '[Redacted]',
    );
  });

  it('redacts embedding and structured-object payloads without fabricating fields', async () => {
    const output: string[] = [];
    const telemetry = createConsoleTelemetry({
      includeTimestamp: false,
      pretty: false,
      logger: {
        log: (value) => output.push(String(value)),
        error: (value) => output.push(String(value)),
      },
    });

    await telemetry.onEmbedEnd?.({
      recordInputs: false,
      recordOutputs: false,
      value: 'SECRET_EMBED_INPUT',
      embedding: [0.1, 0.2],
    } as never);
    await telemetry.onObjectStepStart?.({
      recordInputs: false,
      recordOutputs: true,
      system: 'SECRET_OBJECT_SYSTEM',
      prompt: 'SECRET_OBJECT_PROMPT',
      schema: { description: 'SECRET_OBJECT_SCHEMA' },
      schemaDescription: 'SECRET_SCHEMA_DESCRIPTION',
      schemaName: 'SECRET_SCHEMA_NAME',
      output: { schema: 'SECRET_OUTPUT_SPECIFICATION' },
    } as never);
    await telemetry.onObjectStepEnd?.({
      recordInputs: true,
      recordOutputs: false,
      objectText: 'SECRET_OBJECT_OUTPUT',
      output: { value: 'SECRET_PARSED_OBJECT' },
      error: new Error('SECRET_INVALID_OBJECT_OUTPUT'),
    } as never);

    const records = output.map(
      (line) => JSON.parse(line) as { event: string; data: object },
    );
    const serialized = output.join('\n');
    assert.doesNotMatch(serialized, /SECRET_/);
    assert.match(serialized, /\[Redacted\]/);
    assert.deepStrictEqual(
      records.map(({ event }) => event),
      ['onEmbedEnd', 'onObjectStepStart', 'onObjectStepEnd'],
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
      includeTimestamp: false,
      pretty: false,
      logger: {
        log: (value) => stdout.push(String(value)),
        error: (value) => stderr.push(String(value)),
      },
    });
    const circular: Record<string, unknown> = { label: 'root' };
    circular.self = circular;
    const error = new Error('outer failure', {
      cause: new Error('inner failure'),
    });
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
    const record = JSON.parse(stderr[0]) as {
      event: string;
      data: Record<string, unknown>;
    };
    assert.strictEqual(record.event, 'onError');
    assert.deepStrictEqual(record.data.error, {
      name: 'Error',
      message: 'outer failure',
      stack: error.stack,
      cause: {
        name: 'Error',
        message: 'inner failure',
        stack: (error.cause as Error).stack,
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
      includeTimestamp: false,
      pretty: false,
      logger: {
        log: () => {},
        error: (value) => errors.push(String(value)),
      },
    });
    const payload = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"kept"}',
    );

    await telemetry.onError?.(payload);

    const record = JSON.parse(errors[0]) as {
      data: Record<string, unknown>;
    };
    assert.deepStrictEqual(record.data, payload);
    assert.strictEqual(
      (Object.prototype as { polluted?: boolean }).polluted,
      undefined,
    );
  });

  it('covers every AI SDK telemetry lifecycle callback without duplicate step logs', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const telemetry = createConsoleTelemetry({
      includeTimestamp: false,
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

    for (const name of callbackNames) {
      const callback = telemetry[name] as
        | ((event: unknown) => void | PromiseLike<void>)
        | undefined;
      assert.ok(callback, `${name} should be implemented`);
      await callback({ marker: name });
    }
    await telemetry.onError?.({ marker: 'onError' });

    assert.deepStrictEqual(
      output.map((line) => JSON.parse(line).event),
      callbackNames,
    );
    assert.deepStrictEqual(
      errors.map((line) => JSON.parse(line).event),
      ['onError'],
    );
    assert.strictEqual(telemetry.onStepFinish, undefined);
  });
});
