import { type Telemetry, generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createFileTelemetry } from '@deepagents/context/telemetry/file';

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

async function temporaryLogPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'deepagents-telemetry-'));
  temporaryDirectories.push(directory);
  return join(directory, 'nested', 'ai.jsonl');
}

function createTextModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'test-provider',
    modelId: 'test-model',
    doGenerate: {
      content: [{ type: 'text', text: 'file output' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    },
  });
}

describe('createFileTelemetry()', () => {
  it('writes the complete generateText lifecycle as JSONL', async () => {
    const path = await temporaryLogPath();
    const telemetry = createFileTelemetry({
      path,
      includeTimestamp: false,
    });

    await generateText({
      model: createTextModel(),
      prompt: 'file input',
      telemetry: { integrations: telemetry },
    });

    const records = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; data: unknown });
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

  it('writes every AI SDK telemetry lifecycle callback', async () => {
    const path = await temporaryLogPath();
    const telemetry = createFileTelemetry({
      path,
      includeTimestamp: false,
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

    const records = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string });
    assert.deepStrictEqual(
      records.map(({ event }) => event),
      [...callbackNames, 'onError'],
    );
    assert.strictEqual(telemetry.onStepFinish, undefined);
  });

  it('serializes concurrent writes and can truncate an existing log', async () => {
    const path = await temporaryLogPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'old log entry\n');
    const telemetry = createFileTelemetry({
      path,
      append: false,
      includeTimestamp: false,
    });

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
    assert.strictEqual(lines.length, 600);
    const starts = lines
      .map(
        (line) =>
          JSON.parse(line) as { event: string; data: Record<string, unknown> },
      )
      .filter(({ event }) => event === 'onStart');
    assert.strictEqual(starts.length, 100);
    for (let sequence = 0; sequence < 100; sequence++) {
      assert.ok(
        starts.some(({ data }) =>
          JSON.stringify(data).includes(`sequence-${sequence}`),
        ),
      );
    }
  });

  it('reports write failures without rejecting telemetry callbacks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deepagents-telemetry-'));
    temporaryDirectories.push(directory);
    const blockingFile = join(directory, 'not-a-directory');
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
    const directory = await mkdtemp(join(tmpdir(), 'deepagents-telemetry-'));
    temporaryDirectories.push(directory);
    const blockingFile = join(directory, 'not-a-directory');
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
