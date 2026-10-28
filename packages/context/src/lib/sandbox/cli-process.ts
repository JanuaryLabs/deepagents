import { SubprocessError } from 'nano-spawn';
import { type ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';

import { shellQuote } from './shell-quote.ts';
import type { CommandResult, ExitInfo, SandboxProcess } from './types.ts';

/**
 * The result of a CLI command that nano-spawn rejected: its output and exit
 * code, with the error message standing in for an empty stderr.
 */
export function commandResultFrom(error: unknown): CommandResult {
  if (error instanceof SubprocessError) {
    return {
      stdout: error.stdout,
      stderr: error.stderr || error.message,
      exitCode: error.exitCode ?? 1,
    };
  }
  return {
    stdout: '',
    stderr: error instanceof Error ? error.message : '',
    exitCode: 1,
  };
}

/**
 * Bridge a Node `child_process` — a `container exec` child — into the
 * backend-neutral {@link SandboxProcess} shape: web `ReadableStream` stdio plus
 * an `exit` promise that resolves with the child's exit code.
 *
 * Aborting `abortSignal` sends `SIGKILL`. The Apple `container` CLI traps
 * `SIGTERM` in its client wrapper and exits cleanly with code 0, so `SIGTERM`
 * would look like a successful run; only `SIGKILL` reliably tears the child
 * down and surfaces as a non-success exit.
 */
export function toSandboxProcess(
  child: ChildProcess,
  abortSignal: AbortSignal | undefined,
): SandboxProcess {
  if (!child.stdout || !child.stderr) {
    child.kill('SIGKILL');
    throw new Error('exec child process is missing stdout/stderr streams');
  }

  const onAbort = () => child.kill('SIGKILL');
  if (abortSignal) {
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    stdout: Readable.toWeb(child.stdout),
    stderr: Readable.toWeb(child.stderr),
    exit: new Promise<ExitInfo>((resolve, reject) => {
      const settle = () => {
        child.removeListener('exit', onExitEvent);
        child.removeListener('error', onError);
        abortSignal?.removeEventListener('abort', onAbort);
      };
      const onError = (err: Error) => {
        settle();
        reject(err);
      };
      const onExitEvent = (
        code: number | null,
        exitSignal: NodeJS.Signals | null,
      ) => {
        settle();
        resolve({ code, signal: exitSignal, success: code === 0 });
      };
      child.on('exit', onExitEvent);
      child.on('error', onError);
    }),
  };
}

/** Runs a Bash command in the container: the only file channel of a CLI engine. */
type ExecuteCommand = (command: string) => Promise<CommandResult>;

/**
 * base64 chars per write chunk — a multiple of 4 so each chunk decodes to whole
 * bytes (and appends cleanly), keeping every `bash -lc` argument well under the
 * shell's argument-length limit (ARG_MAX).
 */
const BASE64_WRITE_CHUNK = 32_768;

/**
 * Build the shell commands that decode `content` into `path`. The payload is
 * split into independently-decodable base64 chunks so large files don't blow
 * ARG_MAX, and every argument is shell-quoted. Always returns at least one
 * command (an empty file is created by the final fallback).
 */
function base64WriteCommands(path: string, content: string | Buffer): string[] {
  const base64 = Buffer.from(content).toString('base64');
  const quotedPath = shellQuote(path);
  const commands: string[] = [];
  for (let offset = 0; offset < base64.length; offset += BASE64_WRITE_CHUNK) {
    const chunk = base64.slice(offset, offset + BASE64_WRITE_CHUNK);
    const redirect = offset === 0 ? '>' : '>>';
    commands.push(
      `printf '%s' ${shellQuote(chunk)} | base64 -d ${redirect} ${quotedPath}`,
    );
  }
  if (commands.length === 0) {
    commands.push(`printf '' > ${quotedPath}`);
  }
  return commands;
}

/** Reads `path` as base64 through `executeCommand`. */
export async function readFileOverExec(
  executeCommand: ExecuteCommand,
  path: string,
): Promise<Uint8Array> {
  const result = await executeCommand(`base64 ${shellQuote(path)}`);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to read file "${path}": ${result.stderr}`);
  }
  return Buffer.from(result.stdout, 'base64');
}

/**
 * Whether `path` exists. The answer travels on stdout rather than the exit
 * code because a failed `exec` (engine down, container gone) also exits 1 and
 * would read as "missing".
 */
export async function existsOverExec(
  executeCommand: ExecuteCommand,
  path: string,
): Promise<boolean> {
  const result = await executeCommand(
    `test -e ${shellQuote(path)} && printf true || printf false`,
  );
  if (result.stdout === 'true') return true;
  if (result.stdout === 'false') return false;
  throw new Error(`Failed to check "${path}": ${result.stderr}`);
}

/** Writes each file as base64 through `executeCommand`, creating its parent directory. */
export async function writeFilesOverExec(
  executeCommand: ExecuteCommand,
  files: Array<{ path: string; content: string | Buffer }>,
): Promise<void> {
  for (const file of files) {
    const dir = file.path.substring(0, file.path.lastIndexOf('/'));
    if (dir) {
      await executeCommand(`mkdir -p ${shellQuote(dir)}`);
    }

    for (const command of base64WriteCommands(file.path, file.content)) {
      const result = await executeCommand(command);
      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to write file "${file.path}": ${result.stderr}`,
        );
      }
    }
  }
}
