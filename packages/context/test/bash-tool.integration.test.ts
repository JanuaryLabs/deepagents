import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { asSchema, generateText, isStepCount } from 'ai';
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
  type ReadFileContent,
  type ReadFileEncoding,
  type ReadFileOptions,
  type ReadFileTool,
  type ReadFileToolInput,
  type ReadFileToolResult,
  type WrappedBashTool,
  createBashTool,
  createVirtualSandbox,
  readFileContent,
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
  readonly reads: string[] = [];
  result: CommandResult = { stdout: 'second\n', stderr: '', exitCode: 0 };

  async executeCommand(command: string) {
    this.commands.push(command);
    return this.result;
  }

  async readFile<Encoding extends ReadFileEncoding = 'utf-8'>(
    path: string,
    options?: ReadFileOptions<Encoding>,
  ): Promise<ReadFileContent<Encoding>> {
    this.reads.push(path);
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`Missing file: ${path}`);
    return readFileContent(new TextEncoder().encode(content), options);
  }

  async exists(path: string) {
    return this.files.has(path);
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
  input: ReadFileToolInput,
  toolCallId: string,
): Promise<ReadFileToolResult> {
  const execute = readFile.execute;
  assert.ok(execute);
  const result = await execute(input, executionOptions(toolCallId));
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
      await executeReadFile(
        tools.readFile,
        { path: '.env' },
        'read-uploaded-dotfile',
      ),
      {
        content: 'MODE=test',
      },
    );
    assert.deepStrictEqual(
      await executeReadFile(
        tools.readFile,
        { path: 'shared.txt' },
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
        { path: 'included.txt' },
        'read-included-file',
      ),
      { content: 'included' },
    );
    await assert.rejects(
      executeReadFile(
        tools.readFile,
        { path: 'excluded.log' },
        'read-excluded-file',
      ),
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
        { path: result.teeFiles[0].stdoutFile },
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

  it('advertises js-exec instead of node in JavaScript virtual sandboxes', async () => {
    const { bash } = await createBashTool({
      sandbox: await createVirtualSandbox({
        fs: new InMemoryFs(),
        javascript: true,
      }),
    });

    const description = bash.description;
    assert.ok(typeof description === 'string');
    assert.match(description, /Available tools:.*\bjs-exec\b/);
    assert.doesNotMatch(description, /Available tools:.*\bnode\b/);
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

describe('readFile tool', () => {
  it('does not combine optional inputs with OpenAI strict mode', async () => {
    const { tools } = await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
    });
    const schema = await asSchema(tools.readFile.inputSchema).jsonSchema;
    const required = new Set(schema.required ?? []);
    const missing = Object.keys(schema.properties ?? {}).filter(
      (property) => !required.has(property),
    );

    assert.ok(
      tools.readFile.strict !== true || missing.length === 0,
      `OpenAI strict tools must require every property; missing: ${missing.join(', ')}`,
    );
  });

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );

  it('hands a PNG to the model as an image file part', async () => {
    const { tools, sandbox } = await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
    });
    await sandbox.writeFiles([{ path: '/workspace/pixel.png', content: png }]);
    const model: MockLanguageModelV4 = new MockLanguageModelV4({
      doGenerate: async () =>
        model.doGenerateCalls.length === 1
          ? {
              finishReason: { unified: 'tool-calls' as const, raw: undefined },
              usage: testUsage,
              content: [
                {
                  type: 'tool-call' as const,
                  toolCallId: 'read-png',
                  toolName: 'readFile',
                  input: JSON.stringify({ path: 'pixel.png' }),
                },
              ],
              warnings: [],
            }
          : {
              finishReason: { unified: 'stop' as const, raw: undefined },
              usage: testUsage,
              content: [{ type: 'text' as const, text: 'a single pixel' }],
              warnings: [],
            },
    });

    const generated = await generateText({
      model,
      tools,
      prompt: 'what is in pixel.png?',
      stopWhen: isStepCount(2),
    });

    const base64 = png.toString('base64');
    const output = await executeReadFile(
      tools.readFile,
      { path: 'pixel.png' },
      'read-png',
    );
    assert.deepStrictEqual(output, { mediaType: 'image/png', base64 });
    assert.deepStrictEqual(generated.steps[0].toolResults[0].output, output);
    const toModelOutput = tools.readFile.toModelOutput;
    assert.ok(toModelOutput);
    assert.deepStrictEqual(
      await toModelOutput({
        toolCallId: 'read-png',
        input: { path: 'pixel.png' },
        output,
      }),
      {
        type: 'content',
        value: [
          {
            type: 'file',
            data: { type: 'data', data: base64 },
            mediaType: 'image/png',
            filename: 'pixel.png',
          },
        ],
      },
    );
    const [forwarded] = toolResultOutputs(model.doGenerateCalls[1].prompt);
    assert.ok(forwarded?.type === 'content');
    const [filePart] = forwarded.value;
    assert.ok(filePart?.type === 'file');
    assert.strictEqual(filePart.mediaType, 'image/png');
    assert.strictEqual(filePart.filename, 'pixel.png');
    assert.deepStrictEqual(filePart.data, { type: 'data', data: base64 });
  });

  it('returns a text file as content and sends it to the model as json', async () => {
    const { tools } = await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
      files: { 'notes.txt': 'plain text' },
    });

    const output = await executeReadFile(
      tools.readFile,
      { path: 'notes.txt' },
      'read-text',
    );

    assert.deepStrictEqual(output, { content: 'plain text' });
    const toModelOutput = tools.readFile.toModelOutput;
    assert.ok(toModelOutput);
    assert.deepStrictEqual(
      await toModelOutput({
        toolCallId: 'read-text',
        input: { path: 'notes.txt' },
        output,
      }),
      { type: 'json', value: { content: 'plain text' } },
    );
  });

  it('slices text by 1-based offset and limit', async () => {
    const { tools } = await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
      files: { 'notes.txt': 'first\r\nsecond\nthird\rfourth' },
    });

    assert.deepStrictEqual(
      await executeReadFile(
        tools.readFile,
        { path: 'notes.txt', offset: 2, limit: 2 },
        'read-text-range',
      ),
      { content: 'second\nthird' },
    );
  });

  it('hands a PDF to the model as a document file part', async () => {
    const pdf = Buffer.from(
      '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n',
    );
    const { tools, sandbox } = await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
    });
    await sandbox.writeFiles([{ path: '/workspace/report.pdf', content: pdf }]);

    const output = await executeReadFile(
      tools.readFile,
      { path: 'report.pdf' },
      'read-pdf',
    );

    assert.deepStrictEqual(output, {
      mediaType: 'application/pdf',
      base64: pdf.toString('base64'),
    });
    const toModelOutput = tools.readFile.toModelOutput;
    assert.ok(toModelOutput);
    assert.deepStrictEqual(
      await toModelOutput({
        toolCallId: 'read-pdf',
        input: { path: 'report.pdf' },
        output,
      }),
      {
        type: 'content',
        value: [
          {
            type: 'file',
            data: { type: 'data', data: pdf.toString('base64') },
            mediaType: 'application/pdf',
            filename: 'report.pdf',
          },
        ],
      },
    );
  });

  it('hands every supported image format to the model as a file part', async () => {
    const files = {
      'image.gif': Buffer.from('GIF89a'),
      'image.jpg': Buffer.from([0xff, 0xd8, 0xff]),
      'image.webp': Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.alloc(4),
        Buffer.from('WEBP'),
      ]),
    };
    const mediaTypes = {
      'image.gif': 'image/gif',
      'image.jpg': 'image/jpeg',
      'image.webp': 'image/webp',
    } as const;
    const { tools, sandbox } = await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
    });
    await sandbox.writeFiles(
      Object.entries(files).map(([path, content]) => ({
        path: `/workspace/${path}`,
        content,
      })),
    );

    for (const [path, content] of Object.entries(files)) {
      assert.deepStrictEqual(
        await executeReadFile(tools.readFile, { path }, `read-${path}`),
        {
          mediaType: mediaTypes[path as keyof typeof mediaTypes],
          base64: content.toString('base64'),
        },
      );
    }
  });

  it('hands XLSX, DOCX, and PPTX files to the model as attachments', async () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    const mediaTypes = {
      'document.docx':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'slides.pptx':
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'workbook.xlsx':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    } as const;
    const { tools, sandbox } = await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
    });
    await sandbox.writeFiles(
      Object.keys(mediaTypes).map((path) => ({
        path: `/workspace/${path}`,
        content: bytes,
      })),
    );

    for (const [path, mediaType] of Object.entries(mediaTypes)) {
      const output = await executeReadFile(
        tools.readFile,
        { path },
        `read-${path}`,
      );
      assert.deepStrictEqual(output, {
        mediaType,
        base64: bytes.toString('base64'),
      });

      const toModelOutput = tools.readFile.toModelOutput;
      assert.ok(toModelOutput);
      assert.deepStrictEqual(
        await toModelOutput({
          toolCallId: `read-${path}`,
          input: { path },
          output,
        }),
        {
          type: 'content',
          value: [
            {
              type: 'file',
              data: { type: 'data', data: bytes.toString('base64') },
              mediaType,
              filename: path,
            },
          ],
        },
      );
    }
  });

  it('returns oversized attachments as model-facing errors', async () => {
    const oversizedPng = Buffer.alloc(5 * 1024 * 1024 + 1);
    png.copy(oversizedPng);
    const { tools, sandbox } = await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
    });
    await sandbox.writeFiles([
      { path: '/workspace/oversized.png', content: oversizedPng },
    ]);

    const output = await executeReadFile(
      tools.readFile,
      { path: 'oversized.png' },
      'read-oversized-image',
    );
    assert.ok('error' in output);
    assert.match(output.error, /^Image exceeds 5\.00 MB limit/);
    const toModelOutput = tools.readFile.toModelOutput;
    assert.ok(toModelOutput);
    assert.deepStrictEqual(
      await toModelOutput({
        toolCallId: 'read-oversized-image',
        input: { path: 'oversized.png' },
        output,
      }),
      { type: 'error-text', value: output.error },
    );
  });

  it('stops an aborted read before touching the sandbox', async () => {
    const backend = new RecordingSandbox();
    backend.files.set('/workspace/notes.txt', 'plain text');
    const { tools } = await createBashTool({
      sandbox: backend,
      promptOptions: { toolPrompt: '' },
    });
    const execute = tools.readFile.execute;
    assert.ok(execute);

    await assert.rejects(async () => {
      const result = await execute(
        { path: 'notes.txt' },
        {
          ...executionOptions('read-aborted-file'),
          abortSignal: AbortSignal.abort(new Error('read cancelled')),
        },
      );
      if (isAsyncIterable(result)) {
        assert.fail('expected a buffered file result');
      }
    }, /read cancelled/);
    assert.deepStrictEqual(backend.reads, []);
  });
});
