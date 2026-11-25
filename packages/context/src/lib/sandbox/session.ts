import {
  type Experimental_SandboxProcess,
  extractLines,
} from '@ai-sdk/provider-utils';
import { hash } from 'node:crypto';
import { posix } from 'node:path';
import { text } from 'node:stream/consumers';

import type {
  ChatSandbox,
  CommandResult,
  DisposableSandbox,
  SandboxContext,
  SandboxSession,
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

/** How {@link guardSession} guards the operations of a session. */
export interface SessionGuard {
  /** What `release` runs, once. */
  release: () => Promise<void>;
  /** The message of the Error every operation rejects with once `release` was called. */
  releasedMessage: string;
  /**
   * Rejects with `SandboxNotFoundError` when the sandbox is no longer the one
   * the session reached. Runs before every session operation. A backend whose
   * own calls already reject so gives none.
   */
  assertCurrent?: () => void | Promise<void>;
}

/**
 * Guards every operation of `session`: once `release` was called, each
 * rejects with an Error of `releasedMessage`; until then each runs
 * `assertCurrent` first. `release` runs the guard's `release` once however
 * often it is called, and `assertOpen` throws as a released operation does.
 */
export function guardSession(
  session: SandboxSession,
  { release, releasedMessage, assertCurrent }: SessionGuard,
): {
  session: SandboxSession;
  release: () => Promise<void>;
  assertOpen: () => void;
} {
  let releasing: Promise<void> | undefined;
  const releaseOnce = () => (releasing ??= release());
  const assertOpen = () => {
    if (releasing !== undefined) throw new Error(releasedMessage);
  };
  const live =
    <Args extends unknown[], Result>(
      operation: (...args: Args) => PromiseLike<Result>,
    ) =>
    async (...args: Args): Promise<Result> => {
      assertOpen();
      await assertCurrent?.();
      return operation.apply(session, args);
    };
  return {
    session: Object.assign(session, {
      run: live(session.run),
      spawn: live(session.spawn),
      readFile: live(session.readFile),
      readBinaryFile: live(session.readBinaryFile),
      readTextFile: live(session.readTextFile),
      writeFile: live(session.writeFile),
      writeBinaryFile: live(session.writeBinaryFile),
      writeTextFile: live(session.writeTextFile),
      stat: live(session.stat),
      listDirectory: live(session.listDirectory),
      deleteFile: live(session.deleteFile),
    }),
    release: releaseOnce,
    assertOpen,
  };
}

/** What a backend gives {@link chatSandboxHandle} beside the session. */
export interface ChatSandboxLifecycle extends Omit<
  SessionGuard,
  'releasedMessage'
> {
  /** The backend's `resume`, which makes its own check that the sandbox is the handle's. */
  resume: () => Promise<void>;
}

/**
 * Makes `session` the handle of chat `chatId`. `close` runs `release` once;
 * afterwards every operation, `resume` too, rejects with an Error that names
 * the chat.
 */
export function chatSandboxHandle(
  chatId: string,
  session: SandboxSession,
  { resume, release, assertCurrent }: ChatSandboxLifecycle,
): ChatSandbox {
  const guarded = guardSession(session, {
    release,
    releasedMessage: `The sandbox handle of chat "${chatId}" is closed.`,
    assertCurrent,
  });
  return Object.assign(guarded.session, {
    resume: async () => {
      guarded.assertOpen();
      return resume();
    },
    close: guarded.release,
    [Symbol.asyncDispose]: guarded.release,
  });
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

/** Killing a process on abort failed; the process runs on until it exits. */
class AbortKillWarning extends Error {
  readonly code = 'DEEPAGENTS_CONTEXT_ABORT_KILL_FAILED';
  readonly detail: string;

  constructor(failure: unknown, reason: unknown) {
    super(
      `Killing a process on abort failed, and the process runs on until it exits: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'AbortKillWarning';
    this.detail = `abort reason: ${Error.isError(reason) ? reason.message : String(reason)}`;
  }
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
    void kill().catch((error: unknown) => {
      process.emitWarning(new AbortKillWarning(error, abortSignal?.reason));
    });
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
