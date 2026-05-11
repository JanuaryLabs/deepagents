import type { DisposableSandbox } from './types.ts';

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
  const list = await execute(
    `find ${shellQuote(destination)} -type f -print0 | while IFS= read -r -d '' p; do sha256sum "$p"; done`,
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
 * - If `destination` does not exist in the sandbox at snapshot time, the
 *   snapshot is treated as empty (graceful — supports observation rooted at
 *   paths that the sandbox will create later). Snapshot command failures
 *   (e.g. permission denied, missing `find`) throw `SnapshotFailedError`.
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

  return {
    sandbox: decorated,
    drain(): FileEvent[] {
      return buffer.splice(0, buffer.length);
    },
  };
}
