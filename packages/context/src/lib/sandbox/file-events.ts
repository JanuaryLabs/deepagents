import type { DisposableSandbox, ExitInfo } from './types.ts';

export type FileEventOp = 'read' | 'write' | 'delete' | 'modify';

export interface FileEvent {
  path: string;
  op: FileEventOp;
  timestamp: number;
}

export interface ObserveOptions {
  destination: string;
}

export interface SandboxObserver {
  sandbox: DisposableSandbox;
  drain(): FileEvent[];
}

export class SnapshotFailedError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.name = 'SnapshotFailedError';
    this.stderr = stderr;
  }
}

type Snapshot = Map<string, string>;
type ExecuteCommand = DisposableSandbox['executeCommand'];

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function snapshot(
  execute: ExecuteCommand,
  destination: string,
): Promise<Snapshot> {
  const probe = await execute(`[ -d ${shellQuote(destination)} ]`);
  if (probe.exitCode !== 0) return new Map();
  // The null-delimited `read -d ''` loop trips just-bash's dynamic-import
  // guard; `-exec sha256sum {} +` is portable across backends and space-safe.
  const list = await execute(
    `find ${shellQuote(destination)} -type f -exec sha256sum {} +`,
  );
  if (list.exitCode !== 0) {
    throw new SnapshotFailedError(
      `snapshot failed for ${destination}`,
      list.stderr,
    );
  }
  const snap: Snapshot = new Map();
  if (!list.stdout) return snap;
  for (const line of list.stdout.split('\n')) {
    if (line.length < 66) continue;
    snap.set(line.slice(66), line.slice(0, 64));
  }
  return snap;
}

function lazyReadable(
  innerPromise: Promise<ReadableStream<Uint8Array>>,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!reader) {
        const inner = await innerPromise;
        reader = inner.getReader();
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      if (reader) {
        await reader.cancel(reason);
      } else {
        const inner = await innerPromise;
        await inner.cancel(reason);
      }
    },
  });
}

function diff(before: Snapshot, after: Snapshot): FileEvent[] {
  const events: FileEvent[] = [];
  const ts = Date.now();
  for (const [path, hash] of after) {
    const prior = before.get(path);
    if (prior === undefined) {
      events.push({ path, op: 'write', timestamp: ts });
    } else if (prior !== hash) {
      events.push({ path, op: 'modify', timestamp: ts });
    }
  }
  for (const path of before.keys()) {
    if (!after.has(path)) {
      events.push({ path, op: 'delete', timestamp: ts });
    }
  }
  return events;
}

/**
 * Wraps a `Sandbox` with file-event observation rooted at `destination`.
 *
 * - `executeCommand` and `writeFiles` are bracketed by `find -print0` +
 *   `sha256sum` snapshots; hash diff produces write/modify/delete events.
 * - `readFile` records a `read` event on success.
 * - `spawn` (when the backend exposes it) is bracketed similarly: the
 *   before-snapshot resolves before the inner spawn starts (via a
 *   lazy `ReadableStream`), and the returned `exit` Promise resolves only
 *   after the after-snapshot is recorded. The after-snapshot runs when the
 *   OS reports child exit; data still buffered in stdio after that point
 *   is *not* observed — write events for files flushed only on stream
 *   close may be missed.
 * - If `destination` does not exist in the sandbox at snapshot time, the
 *   snapshot is treated as empty (graceful — supports observation rooted at
 *   paths that the sandbox will create later). Snapshot command failures
 *   (e.g. permission denied, missing `find`) throw `SnapshotFailedError`
 *   from `executeCommand`/`writeFiles`, but are silently dropped on `spawn`
 *   because the caller's signal already comes via `exit`.
 * - Single-flight by convention. Concurrent `executeCommand` calls are not
 *   serialized internally and will produce interleaved diffs.
 */
export function observeSandboxFileEvents(
  sandbox: DisposableSandbox,
  options: ObserveOptions,
): SandboxObserver {
  const { destination } = options;
  if (!destination) {
    throw new Error('observeSandboxFileEvents: destination is required');
  }

  const innerExecute: ExecuteCommand = sandbox.executeCommand.bind(sandbox);
  const innerReadFile = sandbox.readFile.bind(sandbox);
  const innerWriteFiles = sandbox.writeFiles.bind(sandbox);

  const buffer: FileEvent[] = [];

  const observe = async <T>(fn: () => Promise<T>): Promise<T> => {
    const before = await snapshot(innerExecute, destination);
    const takeAfter = async () => {
      const after = await snapshot(innerExecute, destination);
      buffer.push(...diff(before, after));
    };
    try {
      const result = await fn();
      await takeAfter();
      return result;
    } catch (err) {
      await takeAfter().catch(() => {});
      throw err;
    }
  };

  const decorated: DisposableSandbox = {
    async executeCommand(command, options) {
      return observe(() => innerExecute(command, options));
    },
    async readFile(path) {
      const content = await innerReadFile(path);
      buffer.push({ path, op: 'read', timestamp: Date.now() });
      return content;
    },
    async writeFiles(files) {
      await observe(() => innerWriteFiles(files));
    },
    dispose: sandbox.dispose.bind(sandbox),
  };

  if (sandbox.spawn) {
    const innerSpawn = sandbox.spawn.bind(sandbox);
    decorated.spawn = (command, options) => {
      const started = (async () => {
        const before = await snapshot(innerExecute, destination).catch(
          () => new Map<string, string>(),
        );
        const child = innerSpawn(command, options);
        return { before, child };
      })();

      const exit = (async (): Promise<ExitInfo> => {
        const { before, child } = await started;
        try {
          return await child.exit;
        } finally {
          try {
            const after = await snapshot(innerExecute, destination);
            buffer.push(...diff(before, after));
          } catch {
            // snapshot failures are non-fatal for spawn observation
          }
        }
      })();

      const stdoutPromise = started.then((s) => s.child.stdout);
      const stderrPromise = started.then((s) => s.child.stderr);
      // Failure paths surface through `exit`; eagerly attach no-op catches
      // so a caller that spawns without reading either stream still
      // produces a single unhandled-rejection on `exit`, not three.
      stdoutPromise.catch(() => {});
      stderrPromise.catch(() => {});

      return {
        stdout: lazyReadable(stdoutPromise),
        stderr: lazyReadable(stderrPromise),
        exit,
      };
    };
  }

  return {
    sandbox: decorated,
    drain(): FileEvent[] {
      return buffer.splice(0, buffer.length);
    },
  };
}
