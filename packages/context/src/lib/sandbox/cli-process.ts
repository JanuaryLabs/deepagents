import { type ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';

import { shellQuote } from './shell-quote.ts';
import type { ExitInfo, SandboxProcess } from './types.ts';

/**
 * Bridge a Node `child_process` — a `docker exec` / `container exec` child —
 * into the backend-neutral {@link SandboxProcess} shape: web `ReadableStream`
 * stdio plus an `exit` promise that resolves with the child's exit code.
 *
 * Aborting `abortSignal` sends `SIGKILL`. Both the `docker` and Apple
 * `container` CLIs trap `SIGTERM` in their client wrapper and exit cleanly with
 * code 0, so `SIGTERM` would look like a successful run; only `SIGKILL`
 * reliably tears the child down and surfaces as a non-success exit.
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
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
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

/**
 * base64 chars per write chunk — a multiple of 4 so each chunk decodes to whole
 * bytes (and appends cleanly), keeping every `sh -c` argument well under the
 * shell's argument-length limit (ARG_MAX).
 */
const BASE64_WRITE_CHUNK = 32_768;

/**
 * Build the shell commands that decode `content` into `path`, for sandbox
 * backends whose only channel is `executeCommand` (no native file copy). The
 * payload is split into independently-decodable base64 chunks so large files
 * don't blow ARG_MAX, and every argument is shell-quoted. Always returns at
 * least one command (an empty file is created by the final fallback).
 */
export function base64WriteCommands(
  path: string,
  content: string | Buffer,
): string[] {
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

/** Build the command that base64-encodes `path` for reading back to the host. */
export function base64ReadCommand(path: string): string {
  return `base64 ${shellQuote(path)}`;
}
