import { tool } from 'ai';
import fg from 'fast-glob';
import { BashTransformPipeline, TeePlugin } from 'just-bash';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import z from 'zod';

import { withHostOnlyToolMetadata } from '@deepagents/agent';

import { BashException } from './bash-exception.ts';
import { shellQuote } from './shell-quote.ts';
import type {
  AgentSandbox,
  BashToolResult,
  CommandResult,
  CreateBashToolOptions,
  DisposableSandbox,
  ReadFileTool,
  WrappedBashTool,
  WriteFileTool,
} from './types.ts';

const DEFAULT_DESTINATION = '/workspace';
const DEFAULT_MAX_FILES = 1_000;
const DEFAULT_MAX_OUTPUT_LENGTH = 30_000;
const TEE_OUTPUT_DIR = '/tmp/bash-tool';
const WRITE_BATCH_SIZE = 20;

const REASONING_INSTRUCTION =
  'Every bash tool call must include a brief non-empty "reasoning" input explaining why the command is needed.';

const KNOWN_TOOLS = new Set([
  'awk',
  'cat',
  'column',
  'comm',
  'curl',
  'cut',
  'diff',
  'expand',
  'find',
  'fold',
  'grep',
  'head',
  'html-to-markdown',
  'iconv',
  'js-exec',
  'join',
  'jq',
  'node',
  'nl',
  'od',
  'paste',
  'printf',
  'python',
  'rev',
  'sed',
  'sort',
  'split',
  'strings',
  'tail',
  'tee',
  'tr',
  'uniq',
  'unexpand',
  'wc',
  'xan',
  'xargs',
  'xxd',
  'yq',
]);

const FORMAT_TOOLS = {
  json: ['jq'],
  yaml: ['yq'],
  html: ['html-to-markdown'],
  xml: ['yq'],
  csv: ['xan', 'awk', 'cut'],
  toml: ['yq'],
  ini: ['yq'],
} as const;

const FORMAT_LABELS: Record<keyof typeof FORMAT_TOOLS, string> = {
  json: 'JSON',
  yaml: 'YAML',
  html: 'HTML',
  xml: 'XML',
  csv: 'CSV/TSV',
  toml: 'TOML',
  ini: 'INI',
};

const EXTENSION_FORMATS: Record<string, keyof typeof FORMAT_TOOLS> = {
  '.json': 'json',
  '.jsonl': 'json',
  '.ndjson': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'xml',
  '.svg': 'xml',
  '.csv': 'csv',
  '.tsv': 'csv',
  '.toml': 'toml',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.conf': 'ini',
};

/** Catch structured bash errors without spreading class-based sandboxes. */
function withBashExceptionCatch(sandbox: DisposableSandbox): DisposableSandbox {
  const decorated: DisposableSandbox = {
    async executeCommand(command, options) {
      try {
        return await sandbox.executeCommand(command, options);
      } catch (error) {
        if (error instanceof BashException) return error.format();
        throw error;
      }
    },
    readFile: (filePath) => sandbox.readFile(filePath),
    writeFiles: (files) => sandbox.writeFiles(files),
    dispose: () => sandbox.dispose(),
    [Symbol.asyncDispose]() {
      return decorated.dispose();
    },
  };

  if (sandbox.spawn) {
    const spawn = sandbox.spawn.bind(sandbox);
    decorated.spawn = (command, options) => spawn(command, options);
  }

  return decorated;
}

function truncateOutput(
  output: string,
  maxLength: number,
  streamName: 'stdout' | 'stderr',
): string {
  if (output.length <= maxLength) return output;
  const removed = output.length - maxLength;
  return `${output.slice(0, maxLength)}\n\n[${streamName} truncated: ${removed} characters removed]`;
}

function makeTeeScriptPortable(script: string): string {
  const withoutStatusAssignments = script.replace(
    /\s*;\s*__tps\d+=\$\{PIPESTATUS\[\d+\]\}(?:\s+__tps\d+=\$\{PIPESTATUS\[\d+\]\})*\s*;\s*(!\s+)?\(exit\s+\$__tps\d+\)(?:\s*\|\s*\(exit\s+\$__tps\d+\))*/g,
    (_match, negated: string | undefined) => (negated ? '; test $? -ne 0' : ''),
  );
  return `set -o pipefail; ${withoutStatusAssignments}`;
}

type InitialFile =
  { path: string; content: string } | { path: string; sourcePath: string };

async function listInitialFiles(
  options: CreateBashToolOptions,
): Promise<InitialFile[]> {
  const files = new Map<string, InitialFile>();

  if (options.uploadDirectory) {
    const { source, include = '**/*' } = options.uploadDirectory;
    const absoluteSource = path.resolve(source);
    const uploaded = await fg(include, {
      cwd: absoluteSource,
      dot: true,
      onlyFiles: true,
      ignore: ['**/.git/**', '**/node_modules/**'],
    });
    for (const relativePath of uploaded) {
      files.set(relativePath, {
        path: relativePath,
        sourcePath: path.join(absoluteSource, relativePath),
      });
    }
  }

  for (const [relativePath, content] of Object.entries(options.files ?? {})) {
    files.set(relativePath, { path: relativePath, content });
  }

  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  if (maxFiles > 0 && files.size > maxFiles) {
    throw new Error(
      `Too many files to upload: ${files.size} files exceeds the limit of ${maxFiles}. ` +
        'Increase maxFiles, narrow uploadDirectory.include, or upload files before creating the toolkit.',
    );
  }

  return [...files.values()];
}

async function uploadInitialFiles(
  sandbox: DisposableSandbox,
  destination: string,
  files: InitialFile[],
): Promise<void> {
  for (let index = 0; index < files.length; index += WRITE_BATCH_SIZE) {
    const batch = await Promise.all(
      files.slice(index, index + WRITE_BATCH_SIZE).map(async (file) => ({
        path: path.posix.join(destination, file.path),
        content:
          'content' in file ? file.content : await readFile(file.sourcePath),
      })),
    );
    await sandbox.writeFiles(batch);
  }
}

async function createToolPrompt(
  sandbox: DisposableSandbox,
  filenames: string[],
  customPrompt: string | undefined,
): Promise<string> {
  if (customPrompt !== undefined) return customPrompt;

  const result = await sandbox.executeCommand(
    'ls /usr/bin /usr/local/bin /bin /sbin /usr/sbin 2>/dev/null',
  );
  const available = new Set(
    result.stdout.split('\n').filter((entry) => KNOWN_TOOLS.has(entry)),
  );
  if (available.has('js-exec')) available.delete('node');
  if (available.size === 0) return '';

  const lines = [
    `Available tools: ${[...available].sort().join(', ')}, and more`,
  ];
  const formats = new Set(
    filenames
      .map(
        (filename) => EXTENSION_FORMATS[path.extname(filename).toLowerCase()],
      )
      .filter((format) => format !== undefined),
  );
  for (const format of formats) {
    const tools = FORMAT_TOOLS[format].filter((name) => available.has(name));
    if (tools.length > 0) {
      lines.push(`For ${FORMAT_LABELS[format]}: ${tools.join(', ')}`);
    }
  }
  return lines.join('\n');
}

function createBashDescription(options: {
  destination: string;
  filenames: string[];
  toolPrompt: string;
  extraInstructions: string;
  experimentalTeeTransform: boolean;
}): string {
  const lines = [
    'Execute bash commands in the sandbox environment.',
    '',
    `WORKING DIRECTORY: ${options.destination}`,
    'All commands execute from this directory. Use relative paths from here.',
    '',
  ];

  if (options.filenames.length > 0) {
    lines.push('Available files:');
    for (const filename of options.filenames.slice(0, 8)) {
      lines.push(`  ${filename}`);
    }
    if (options.filenames.length > 8) {
      lines.push(`  ... and ${options.filenames.length - 8} more files`);
    }
    lines.push('');
  }

  if (options.toolPrompt) lines.push(options.toolPrompt, '');

  lines.push(
    'Common operations:',
    '  ls -la              # List files with details',
    "  find . -name '*.ts' # Find files by pattern",
    "  grep -r 'pattern' . # Search file contents",
    '  cat <file>          # View file contents',
    '',
  );

  if (options.experimentalTeeTransform) {
    lines.push(
      'INTERMEDIATE OUTPUT CAPTURE:',
      `Pipeline stdout is captured under ${TEE_OUTPUT_DIR}/.`,
      'Use the returned teeFiles paths to inspect full intermediate output.',
      '',
    );
  }

  if (options.extraInstructions) {
    lines.push(options.extraInstructions, '');
  }

  return lines.join('\n').trim();
}

/**
 * Build the DeepAgents-owned bash/readFile/writeFile toolkit around a sandbox.
 * The sandbox provides isolation and execution; these tools only translate AI
 * SDK tool calls into that backend contract.
 */
export async function createBashTool(
  options: CreateBashToolOptions,
): Promise<AgentSandbox> {
  const destination = options.destination ?? DEFAULT_DESTINATION;
  const initialFiles = await listInitialFiles(options);
  const sandbox = withBashExceptionCatch(options.sandbox);

  await uploadInitialFiles(sandbox, destination, initialFiles);
  const toolPrompt = await createToolPrompt(
    sandbox,
    initialFiles.map((file) => file.path),
    options.promptOptions?.toolPrompt,
  );
  const extraInstructions = [options.extraInstructions, REASONING_INSTRUCTION]
    .filter(Boolean)
    .join('\n\n');
  const experimentalTeeTransform = options.experimentalTeeTransform ?? false;

  const bash: WrappedBashTool = tool({
    description: createBashDescription({
      destination,
      filenames: initialFiles.map((file) => file.path),
      toolPrompt,
      extraInstructions,
      experimentalTeeTransform,
    }),
    inputSchema: z.object({
      command: z.string().describe('The bash command to execute'),
      reasoning: z
        .string()
        .trim()
        .min(1)
        .describe('Brief reason for executing this command'),
    }),
    execute: async (
      { command: originalCommand },
      executionOptions,
    ): Promise<BashToolResult> => {
      let command = originalCommand;
      const before = options.onBeforeBashCall?.({ command });
      if (before?.command !== undefined) command = before.command;

      let fullCommand: string;
      let teeFiles: CommandResult['teeFiles'];
      if (experimentalTeeTransform) {
        const pipeline = new BashTransformPipeline().use(
          new TeePlugin({ outputDir: TEE_OUTPUT_DIR }),
        );
        const transformed = pipeline.transform(command);
        fullCommand =
          `mkdir -p ${shellQuote(TEE_OUTPUT_DIR)} ${shellQuote(destination)} && ` +
          `cd ${shellQuote(destination)} && ${makeTeeScriptPortable(transformed.script)}`;
        teeFiles = transformed.metadata.teeFiles.map(
          (file: { command: string; stdoutFile: string }) => ({
            command: file.command,
            stdoutFile: file.stdoutFile,
          }),
        );
      } else {
        fullCommand =
          `mkdir -p ${shellQuote(destination)} && ` +
          `cd ${shellQuote(destination)} && ${command}`;
      }

      let result = await sandbox.executeCommand(fullCommand, {
        signal: executionOptions.abortSignal,
      });
      const maxOutputLength =
        options.maxOutputLength ?? DEFAULT_MAX_OUTPUT_LENGTH;
      result = {
        ...result,
        stdout: truncateOutput(result.stdout, maxOutputLength, 'stdout'),
        stderr: truncateOutput(result.stderr, maxOutputLength, 'stderr'),
        ...(teeFiles ? { teeFiles } : {}),
      };

      const executionMeta = result.meta;
      const after = options.onAfterBashCall?.({ command, result });
      if (after?.result !== undefined) result = after.result;

      const meta = { ...executionMeta, ...result.meta, ...after?.meta };
      return Object.keys(meta).length > 0 ? { ...result, meta } : result;
    },
  });

  const readFile: ReadFileTool = tool({
    description: 'Read the contents of a file from the sandbox.',
    inputSchema: z.object({
      path: z.string().describe('The path to the file to read'),
    }),
    execute: async ({ path: filePath }) => ({
      content: await sandbox.readFile(
        path.posix.resolve(destination, filePath),
      ),
    }),
  });

  const writeFile: WriteFileTool = tool({
    description:
      'Write content to a file in the sandbox. Creates parent directories if needed.',
    inputSchema: z.object({
      path: z.string().describe('The path where the file should be written'),
      content: z.string().describe('The content to write to the file'),
    }),
    execute: async ({ path: filePath, content }) => {
      try {
        await sandbox.writeFiles([
          {
            path: path.posix.resolve(destination, filePath),
            content,
          },
        ]);
        return { success: true } as const;
      } catch (error) {
        if (error instanceof BashException) return error.format();
        throw error;
      }
    },
  });

  const tools = withHostOnlyToolMetadata({ bash, readFile, writeFile });
  return { bash: tools.bash, tools, sandbox };
}

export { DEFAULT_MAX_OUTPUT_LENGTH };
