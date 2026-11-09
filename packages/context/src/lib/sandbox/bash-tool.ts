import { tool } from 'ai';
import fg from 'fast-glob';
import { BashTransformPipeline, TeePlugin } from 'just-bash';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import z from 'zod';

import { withHostOnlyToolMetadata } from '@deepagents/agent';

import { BashException } from './bash-exception.ts';
import { fromLegacySandbox } from './legacy-sandbox.ts';
import { createReadFileTool } from './read-file-tool/index.ts';
import { shellQuote } from './shell-quote.ts';
import {
  type AgentSandbox,
  type BashToolResult,
  type CommandResult,
  type CreateBashToolOptions,
  type DisposableSandbox,
  type WrappedBashTool,
  type WriteFileTool,
} from './types.ts';

const DEFAULT_MAX_FILES = 1_000;
const DEFAULT_MAX_OUTPUT_LENGTH = 30_000;
const TEE_OUTPUT_DIR = '/tmp/bash-tool';
const MAX_CONCURRENT_WRITES = 20;
const COMMAND_TIMEOUT_EXIT_CODE = 124;

const REASONING_INSTRUCTION =
  'Every bash tool call must include a brief non-empty "reasoning" input explaining why the command is needed.';

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

/**
 * A `timeout` of the AI SDK reaches the tool as a `TimeoutError` abort reason. The
 * tool timeout and the total timeout give the same reason, but after a total
 * timeout the turn has ended, so the result reaches nobody.
 */
function isTimeoutOf(signal: AbortSignal | undefined, error: unknown): boolean {
  return (
    error === signal?.reason &&
    error instanceof DOMException &&
    error.name === 'TimeoutError'
  );
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
  workingDirectory: string | undefined,
  files: InitialFile[],
): Promise<void> {
  for (let index = 0; index < files.length; index += MAX_CONCURRENT_WRITES) {
    await Promise.all(
      files.slice(index, index + MAX_CONCURRENT_WRITES).map(async (file) => {
        const target =
          workingDirectory === undefined
            ? file.path
            : path.posix.join(workingDirectory, file.path);
        await ('content' in file
          ? sandbox.writeTextFile({ path: target, content: file.content })
          : sandbox.writeBinaryFile({
              path: target,
              content: await readFile(file.sourcePath),
            }));
      }),
    );
  }
}

function createBashDescription(options: {
  workingDirectory: string | undefined;
  sandboxDescription: string;
  extraInstructions: string | undefined;
  experimentalTeeTransform: boolean;
}): string {
  return [
    'Run Bash commands in the sandbox. ' +
      (options.workingDirectory !== undefined
        ? `Every command starts in ${options.workingDirectory}. `
        : "Commands run in the sandbox's default working directory. ") +
      'Use ls to discover files and commands such as cat, grep, sort, awk, and jq to inspect and transform them. ' +
      'Pipes and redirections are supported. Returns stdout, stderr, and exitCode; long output is truncated.',
    options.sandboxDescription,
    options.experimentalTeeTransform &&
      `Pipeline stdout is captured under ${TEE_OUTPUT_DIR}/. Use the returned teeFiles paths to inspect full intermediate output.`,
    options.extraInstructions,
    REASONING_INSTRUCTION,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Build the DeepAgents-owned bash/readFile/writeFile toolkit around a sandbox.
 * The sandbox provides isolation and execution; these tools only translate AI
 * SDK tool calls into that backend contract.
 */
export async function createBashTool(
  options: CreateBashToolOptions,
): Promise<AgentSandbox> {
  const { workingDirectory } = options;
  const sandbox =
    'run' in options.sandbox
      ? options.sandbox
      : fromLegacySandbox(options.sandbox);
  const initialFiles = await listInitialFiles(options);

  if (workingDirectory !== undefined) {
    const created = await sandbox.run({
      command: `mkdir -p -- ${shellQuote(workingDirectory)}`,
    });
    if (created.exitCode !== 0) {
      throw new Error(
        `Could not set up working directory ${workingDirectory}: ${created.stderr}`,
      );
    }
  }
  await uploadInitialFiles(sandbox, workingDirectory, initialFiles);

  const experimentalTeeTransform = options.experimentalTeeTransform ?? false;

  const bash: WrappedBashTool = tool({
    description: createBashDescription({
      workingDirectory,
      sandboxDescription: sandbox.description,
      extraInstructions: options.extraInstructions,
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

      let script = command;
      let teeFiles: CommandResult['teeFiles'];
      if (experimentalTeeTransform) {
        const pipeline = new BashTransformPipeline().use(
          new TeePlugin({ outputDir: TEE_OUTPUT_DIR }),
        );
        const transformed = pipeline.transform(command);
        script = `mkdir -p ${shellQuote(TEE_OUTPUT_DIR)} && ${makeTeeScriptPortable(transformed.script)}`;
        teeFiles = transformed.metadata.teeFiles.map(
          (file: { command: string; stdoutFile: string }) => ({
            command: file.command,
            stdoutFile: file.stdoutFile,
          }),
        );
      }

      const { abortSignal } = executionOptions;
      const startedAt = performance.now();
      let result: CommandResult;
      try {
        result = await sandbox.run({
          command: script,
          ...(workingDirectory !== undefined ? { workingDirectory } : {}),
          abortSignal,
        });
      } catch (error) {
        if (error instanceof BashException) {
          result = error.format();
        } else if (isTimeoutOf(abortSignal, error)) {
          result = {
            stdout: '',
            stderr: `Command timed out after ${Math.round(performance.now() - startedAt)} ms`,
            exitCode: COMMAND_TIMEOUT_EXIT_CODE,
          };
        } else {
          throw error;
        }
      }
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

  const readFileTool = createReadFileTool({ sandbox, workingDirectory });

  const writeFile: WriteFileTool = tool({
    description:
      'Write content to a file in the sandbox. Creates parent directories if needed.',
    inputSchema: z.object({
      path: z.string().describe('The path where the file should be written'),
      content: z.string().describe('The content to write to the file'),
    }),
    execute: async ({ path: filePath, content }) => {
      try {
        await sandbox.writeTextFile({
          path:
            workingDirectory === undefined
              ? filePath
              : path.posix.resolve(workingDirectory, filePath),
          content,
        });
        return { success: true } as const;
      } catch (error) {
        if (error instanceof BashException) return error.format();
        throw error;
      }
    },
  });

  const tools = withHostOnlyToolMetadata({
    bash,
    readFile: readFileTool,
    writeFile,
  });
  return { bash: tools.bash, tools, sandbox };
}
