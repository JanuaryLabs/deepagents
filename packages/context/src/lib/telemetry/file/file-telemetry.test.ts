import {
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
import { mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import { createFileTelemetry } from '@deepagents/context/telemetry/file';

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

function createTextModel(text = 'file output'): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'test-provider',
    modelId: 'test-model',
    doGenerate: {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    },
  });
}

async function readRecords(path: string) {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => objectTelemetryRecord.parse(JSON.parse(line)));
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
    model: createTextModel('{"value":"object"}'),
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

describe('createFileTelemetry()', () => {
  it('writes the timestamped generateText lifecycle as JSONL', async (t) => {
    const timestamp = '2026-07-12T10:00:00.000Z';
    t.mock.timers.enable({ apis: ['Date'] });
    t.mock.timers.setTime(Date.parse(timestamp));
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'deepagents-telemetry-'),
    );
    const path = join(directory.path, 'nested', 'ai.jsonl');
    const telemetry = createFileTelemetry({ path });
    assert.deepEqual(telemetry.traces, { path: pathToFileURL(path).href });

    await generateText({
      model: createTextModel(),
      prompt: 'file input',
      telemetry: { integrations: telemetry },
    });

    const records = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => telemetryRecord.parse(JSON.parse(line)));
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
    assert.match(JSON.stringify(records), /file input/);
    assert.match(JSON.stringify(records), /file output/);
  });

  it('redacts runtime context when inputs are not recorded', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'deepagents-telemetry-'),
    );
    const path = join(directory.path, 'nested', 'ai.jsonl');
    const telemetry = createFileTelemetry({ path });

    await generateText({
      model: createTextModel(),
      prompt: 'SECRET_PROMPT',
      runtimeContext: { private: { secret: 'SECRET_CONTEXT' } },
      telemetry: {
        integrations: telemetry,
        recordInputs: false,
        recordOutputs: false,
        // Without this opt-in the SDK hands telemetry an empty runtimeContext.
        includeRuntimeContext: { private: true },
      },
    });

    const [{ event, data }] = await readRecords(path);
    assert.equal(event, 'onStart');
    assert.equal(data.runtimeContext, '[Redacted]');
    assert.doesNotMatch(await readFile(path, 'utf8'), /SECRET_/);
  });

  it('writes every AI SDK telemetry lifecycle callback', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'deepagents-telemetry-'),
    );
    const path = join(directory.path, 'nested', 'ai.jsonl');
    const telemetry = createFileTelemetry({ path });
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
      'onError',
    ] as const satisfies readonly (keyof Telemetry)[];

    await triggerEveryTelemetryCallback(telemetry);

    const records = await readRecords(path);
    assert.deepStrictEqual(
      new Set(records.map(({ event }) => event)),
      new Set(callbackNames),
    );
    assert.strictEqual(telemetry.onStepFinish, undefined);
  });

  it('preserves existing records and serializes concurrent writes', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'deepagents-telemetry-'),
    );
    const path = join(directory.path, 'nested', 'ai.jsonl');
    await generateText({
      model: createTextModel(),
      prompt: 'before-restart',
      telemetry: { integrations: createFileTelemetry({ path }) },
    });
    const telemetry = createFileTelemetry({ path });

    const model = createTextModel();
    await Promise.all(
      Array.from({ length: 100 }, (_, sequence) =>
        generateText({
          model,
          prompt: `sequence-${sequence}`,
          telemetry: { integrations: telemetry },
        }),
      ),
    );

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    assert.strictEqual(lines.length, 606);
    const starts = lines
      .map((line) => objectTelemetryRecord.parse(JSON.parse(line)))
      .filter(({ event }) => event === 'onStart');
    assert.strictEqual(starts.length, 101);
    assert.ok(
      starts.some(({ data }) =>
        JSON.stringify(data).includes('before-restart'),
      ),
    );
    for (let sequence = 0; sequence < 100; sequence++) {
      assert.ok(
        starts.some(({ data }) =>
          JSON.stringify(data).includes(`sequence-${sequence}`),
        ),
      );
    }
  });

  it('reports write failures without rejecting telemetry callbacks', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'deepagents-telemetry-'),
    );
    const blockingFile = join(directory.path, 'not-a-directory');
    await writeFile(blockingFile, 'content');
    const errors: unknown[] = [];
    const telemetry = createFileTelemetry({
      path: join(blockingFile, 'ai.jsonl'),
      onWriteError: (error) => {
        errors.push(error);
      },
    });

    await assert.doesNotReject(async () => {
      await generateText({
        model: createTextModel(),
        prompt: 'write-error',
        telemetry: { integrations: telemetry },
      });
    });
    assert.ok(errors.length > 0);
    assert.ok(errors[0] instanceof Error);
  });

  it('handles initialization failures before any telemetry event', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'deepagents-telemetry-'),
    );
    const blockingFile = join(directory.path, 'not-a-directory');
    await writeFile(blockingFile, 'content');
    let reportError!: (error: unknown) => void;
    const errorReported = new Promise<unknown>((resolve) => {
      reportError = resolve;
    });

    createFileTelemetry({
      path: join(blockingFile, 'ai.jsonl'),
      onWriteError: (error) => reportError(error),
    });

    const error = await Promise.race([
      errorReported,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('initialization error was not reported')),
          100,
        ),
      ),
    ]);
    assert.ok(error instanceof Error);
  });
});
