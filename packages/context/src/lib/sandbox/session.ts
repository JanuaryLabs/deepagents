import {
  type Experimental_SandboxProcess,
  extractLines,
} from '@ai-sdk/provider-utils';
import { hash } from 'node:crypto';
import { posix } from 'node:path';
import { text } from 'node:stream/consumers';

import type {
  CommandResult,
  DisposableSandbox,
  SandboxContext,
} from './types.ts';

// The parts every process-backed session builds the same way: the container,
// Microsandbox and Daytona sessions. How each backend kills, stats, lists and
// deletes stays with the backend.

/** The native name of a chat's sandbox: one per namespace and chat, valid on every backend. */
export function chatSandboxName(
  namespace: string,
  chat: SandboxContext,
): string {
  return `sandbox-${hash('sha256', JSON.stringify([namespace, chat.chatId])).slice(0, 32)}`;
}

/** The labels every chat sandbox carries, so an operator or a test finds it by chat. */
export function chatSandboxLabels(
  namespace: string,
  chat: SandboxContext,
): Record<string, string> {
  return {
    'deepagents.sandbox.namespace': namespace,
    'deepagents.sandbox.chat': chat.chatId,
  };
}

/** The contract types `encoding` as a string; Node accepts only its own names. */
function bufferEncoding(encoding = 'utf-8'): BufferEncoding {
  if (!Buffer.isEncoding(encoding)) {
    throw new TypeError(`Unknown encoding: ${encoding}`);
  }
  return encoding;
}

/**
 * `path` against `directory` when it is relative. Joined, not normalized, so
 * that `link/..` follows the link, as it does in a command.
 */
export function resolveIn(directory: string, path: string): string {
  return posix.isAbsolute(path) ? path : `${directory}/${path}`;
}

/** The text calls of a session, over its binary calls. */
export function textCalls({
  readBinaryFile,
  writeBinaryFile,
}: Pick<DisposableSandbox, 'readBinaryFile' | 'writeBinaryFile'>): Pick<
  DisposableSandbox,
  'readTextFile' | 'writeTextFile'
> {
  return {
    readTextFile: async ({ startLine, endLine, encoding, ...options }) => {
      const bytes = await readBinaryFile(options);
      if (!bytes) return null;
      return extractLines({
        text: Buffer.from(bytes).toString(bufferEncoding(encoding)),
        startLine,
        endLine,
      });
    },
    writeTextFile: ({ content, encoding, ...options }) =>
      writeBinaryFile({
        ...options,
        content: Buffer.from(content, bufferEncoding(encoding)),
      }),
  };
}

/**
 * The control of a spawned process: a kill that runs once however often it is
 * called, a kill when `abortSignal` aborts (at once when it already has), and
 * a `wait` that rejects with the abort reason once the process is gone.
 */
export function controlProcess({
  exitCode,
  kill: stop,
  abortSignal,
}: {
  exitCode: Promise<number>;
  kill: () => Promise<void>;
  abortSignal: AbortSignal | undefined;
}): {
  wait: Experimental_SandboxProcess['wait'];
  kill: () => Promise<void>;
} {
  let killing: Promise<void> | undefined;
  const kill = () => (killing ??= stop());
  const onAbort = () => {
    // Observes a failed kill at once; `exitCode` still reports how the
    // process ended.
    void kill().catch(() => {});
  };
  if (abortSignal?.aborted) onAbort();
  else abortSignal?.addEventListener('abort', onAbort, { once: true });
  void exitCode
    .catch(() => {})
    .finally(() => abortSignal?.removeEventListener('abort', onAbort));
  return {
    wait: async () => ({
      exitCode: await exitCode.finally(() => abortSignal?.throwIfAborted()),
    }),
    kill,
  };
}

/** Reads a spawned process to its end, as `run` returns it. */
export async function collect(
  process: Experimental_SandboxProcess,
): Promise<CommandResult> {
  const [stdout, stderr, { exitCode }] = await Promise.all([
    text(process.stdout),
    text(process.stderr),
    process.wait(),
  ]);
  return { stdout, stderr, exitCode };
}

interface ByteReadable {
  stream: ReadableStream<Uint8Array>;
  enqueue(chunk: Uint8Array): void;
  close(): void;
  error(reason: unknown): void;
}

/**
 * A byte stream fed from one interleaved process output. One source feeds two
 * of these, so honoring each stream's backpressure would deadlock (waiting on
 * stdout's `pull` while the next chunk is stderr stalls both): chunks queue
 * until read. After its reader cancels, chunks for it are dropped and the
 * process keeps running, as the AI SDK's own sandbox adapter does.
 */
export function createByteReadable(): ByteReadable {
  const ended: Omit<ByteReadable, 'stream'> = {
    enqueue() {},
    close() {},
    error() {},
  };
  let sink = ended;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sink = {
        enqueue(chunk) {
          if (chunk.length > 0) controller.enqueue(chunk);
        },
        close() {
          sink = ended;
          controller.close();
        },
        error(reason) {
          sink = ended;
          controller.error(reason);
        },
      };
    },
    cancel() {
      sink = ended;
    },
  });

  return {
    stream,
    enqueue: (chunk) => sink.enqueue(chunk),
    close: () => sink.close(),
    error: (reason) => sink.error(reason),
  };
}
