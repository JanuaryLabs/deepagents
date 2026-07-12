import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { generateText, isStepCount } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  type BashToolInput,
  type CommandResult,
  type ReadFileTool,
  type ReadFileToolResult,
  type WrappedBashTool,
  createBashTool,
  createVirtualSandbox,
} from '@deepagents/context';

const testUsage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

class RecordingSandbox {
  readonly commands: string[] = [];
  readonly files = new Map<string, string>();
  result: CommandResult = { stdout: 'second\n', stderr: '', exitCode: 0 };

  async executeCommand(command: string) {
    this.commands.push(command);
    return this.result;
  }

  async readFile(path: string) {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`Missing file: ${path}`);
    return content;
  }

  async writeFiles(files: Array<{ path: string; content: string | Buffer }>) {
    for (const file of files) {
      this.files.set(
        file.path,
        typeof file.content === 'string'
          ? file.content
          : file.content.toString('utf8'),
      );
    }
  }

  async dispose() {}

  async [Symbol.asyncDispose]() {
    await this.dispose();
  }
}

function executionOptions(toolCallId: string) {
  return {
    abortSignal: undefined,
    context: {},
    messages: [],
    toolCallId,
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' && value !== null && Symbol.asyncIterator in value
  );
}

async function executeBash(
  bash: WrappedBashTool,
  input: BashToolInput,
  toolCallId: string,
): Promise<CommandResult> {
  const execute = bash.execute;
  assert.ok(execute);
  const result = await execute(input, executionOptions(toolCallId));
  if (isAsyncIterable(result)) assert.fail('expected a buffered bash result');
  return result;
}

async function executeReadFile(
  readFile: ReadFileTool,
  path: string,
  toolCallId: string,
): Promise<ReadFileToolResult> {
  const execute = readFile.execute;
  assert.ok(execute);
  const result = await execute({ path }, executionOptions(toolCallId));
  if (isAsyncIterable(result)) assert.fail('expected a buffered file result');
  return result;
}

function toolResultOutputs(prompt: LanguageModelV4Prompt) {
  return prompt.flatMap((message) =>
    message.role === 'tool'
      ? message.content
          .filter((part) => part.type === 'tool-result')
          .map((part) => part.output)
      : [],
  );
}

describe('bash toolkit', () => {
  it('uploads dotfiles and lets inline files override directory files', async (t) => {
    const source = await mkdtemp(join(tmpdir(), 'deepagents-bash-tool-'));
    t.after(() => rm(source, { recursive: true, force: true }));
    await writeFile(join(source, '.env'), 'MODE=test');
    await writeFile(join(source, 'shared.txt'), 'from directory');

    const { tools } = await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
      files: { 'shared.txt': 'from inline files' },
      uploadDirectory: { source, include: '**/*' },
    });

    assert.deepStrictEqual(
      await executeReadFile(tools.readFile, '.env', 'read-uploaded-dotfile'),
      {
        content: 'MODE=test',
      },
    );
    assert.deepStrictEqual(
      await executeReadFile(
        tools.readFile,
        'shared.txt',
        'read-overridden-file',
      ),
      { content: 'from inline files' },
    );
  });

  it('applies the upload filter before enforcing the file limit', async (t) => {
    const source = await mkdtemp(join(tmpdir(), 'deepagents-bash-tool-'));
    t.after(() => rm(source, { recursive: true, force: true }));
    await writeFile(join(source, 'included.txt'), 'included');
    await writeFile(join(source, 'excluded.log'), 'excluded');

    const { tools } = await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
      uploadDirectory: { source, include: '**/*.txt' },
      maxFiles: 1,
    });
    assert.deepStrictEqual(
      await executeReadFile(
        tools.readFile,
        'included.txt',
        'read-included-file',
      ),
      { content: 'included' },
    );
    await assert.rejects(
      executeReadFile(tools.readFile, 'excluded.log', 'read-excluded-file'),
    );
  });

  it('rejects an over-limit upload before writing any files', async (t) => {
    const source = await mkdtemp(join(tmpdir(), 'deepagents-bash-tool-'));
    t.after(() => rm(source, { recursive: true, force: true }));
    await writeFile(join(source, 'first.txt'), 'first');
    await writeFile(join(source, 'second.txt'), 'second');
    const backend = new RecordingSandbox();

    await assert.rejects(
      createBashTool({
        sandbox: backend,
        uploadDirectory: { source },
        maxFiles: 1,
      }),
      /2 files exceeds the limit of 1/,
    );
    assert.strictEqual(backend.files.size, 0);
  });

  it('keeps tee capture files under the established bash-tool directory', async () => {
    const backend = new RecordingSandbox();
    const { bash } = await createBashTool({
      sandbox: backend,
      experimentalTeeTransform: true,
      promptOptions: { toolPrompt: '' },
    });
    const result = await executeBash(
      bash,
      {
        command: "printf 'first\\nsecond\\n' | tail -1",
        reasoning: 'capture the complete pipeline output',
      },
      'capture-pipeline-output',
    );

    assert.strictEqual(result.stdout.trim(), 'second');
    assert.match(backend.commands[0], /mkdir -p '\/tmp\/bash-tool'/);
    assert.ok(result.teeFiles?.length);
    assert.ok(
      result.teeFiles.every(({ stdoutFile }) =>
        stdoutFile.startsWith('/tmp/bash-tool/'),
      ),
    );
  });

  it('captures full intermediate output in the virtual sandbox', async () => {
    const { bash, tools } = await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
      experimentalTeeTransform: true,
    });

    const result = await executeBash(
      bash,
      {
        command: "printf 'first\\nsecond\\n' | tail -1",
        reasoning: 'retain output before tail truncates it',
      },
      'capture-virtual-pipeline',
    );
    assert.strictEqual(result.stdout.trim(), 'second');
    assert.ok(result.teeFiles?.[0]);
    assert.deepStrictEqual(
      await executeReadFile(
        tools.readFile,
        result.teeFiles[0].stdoutFile,
        'read-captured-pipeline',
      ),
      { content: 'first\nsecond\n' },
    );
  });

  it('supports sandbox backends implemented with prototype methods', async () => {
    const backend = new RecordingSandbox();
    const { tools } = await createBashTool({
      sandbox: backend,
      promptOptions: { toolPrompt: '' },
    });
    const write = tools.writeFile.execute;
    const read = tools.readFile.execute;
    assert.ok(write);
    assert.ok(read);

    await write(
      { path: 'notes/result.txt', content: 'prototype methods work' },
      executionOptions('write-file'),
    );

    assert.deepStrictEqual(
      await read({ path: 'notes/result.txt' }, executionOptions('read-file')),
      { content: 'prototype methods work' },
    );
  });

  it('describes discovered tools and format-specific helpers', async () => {
    const backend = new RecordingSandbox();
    backend.result = {
      stdout: 'jq\nxan\nawk\ncut\nfold\nnl\nexpand\nunexpand\nod\n',
      stderr: '',
      exitCode: 0,
    };
    const { bash } = await createBashTool({
      sandbox: backend,
      files: { 'data.json': '{}', 'records.csv': 'id\n1\n' },
    });

    const description = bash.description;
    assert.ok(typeof description === 'string');
    assert.match(description, /Available tools:.*fold.*nl.*od/);
    assert.match(description, /For JSON: jq/);
    assert.match(description, /For CSV\/TSV: xan, awk, cut/);
  });

  it('runs hooks around truncated output and merges their metadata', async () => {
    const backend = new RecordingSandbox();
    backend.result = {
      stdout: '123456',
      stderr: 'abcdef',
      exitCode: 0,
      meta: { fileChanges: ['/workspace/result.txt'], source: 'sandbox' },
    };
    const { bash } = await createBashTool({
      sandbox: backend,
      maxOutputLength: 3,
      promptOptions: { toolPrompt: '' },
      onBeforeBashCall: ({ command }) => ({
        command: command.replace('draft', 'final'),
      }),
      onAfterBashCall: ({ command, result }) => {
        assert.strictEqual(command, 'echo final');
        assert.match(result.stdout, /^123\n\n\[stdout truncated:/);
        assert.match(result.stderr, /^abc\n\n\[stderr truncated:/);
        return {
          result: {
            stdout: 'hooked\n',
            stderr: 'hooked error\n',
            exitCode: 7,
          },
          meta: { formattedSql: 'SELECT 1', source: 'hook' },
        };
      },
    });
    const model: MockLanguageModelV4 = new MockLanguageModelV4({
      doGenerate: async () => {
        return model.doGenerateCalls.length === 1
          ? {
              finishReason: { unified: 'tool-calls' as const, raw: undefined },
              usage: testUsage,
              content: [
                {
                  type: 'tool-call' as const,
                  toolCallId: 'run-hooks',
                  toolName: 'bash',
                  input: JSON.stringify({
                    command: 'echo draft',
                    reasoning: 'exercise both hooks',
                  }),
                },
              ],
              warnings: [],
            }
          : {
              finishReason: { unified: 'stop' as const, raw: undefined },
              usage: testUsage,
              content: [{ type: 'text' as const, text: 'done' }],
              warnings: [],
            };
      },
    });

    const generated = await generateText({
      model,
      tools: { bash },
      prompt: 'run the command',
      stopWhen: isStepCount(2),
    });
    const result = generated.steps[0].toolResults[0].output;

    assert.match(backend.commands[0], /echo final$/);
    assert.deepStrictEqual(result, {
      stdout: 'hooked\n',
      stderr: 'hooked error\n',
      exitCode: 7,
      meta: {
        fileChanges: ['/workspace/result.txt'],
        formattedSql: 'SELECT 1',
        source: 'hook',
      },
    });
    assert.deepStrictEqual(toolResultOutputs(model.doGenerateCalls[1].prompt), [
      {
        type: 'json',
        value: {
          stdout: 'hooked\n',
          stderr: 'hooked error\n',
          exitCode: 7,
        },
      },
    ]);
  });
});
