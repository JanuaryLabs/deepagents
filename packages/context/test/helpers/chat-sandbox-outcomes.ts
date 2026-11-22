import {
  type ChatSandbox,
  SandboxNotFoundError,
  type SandboxSession,
} from '@deepagents/context';

/** Every session operation, each with arguments that succeed on a live sandbox. */
const sessionOperations = {
  run: (sandbox) => sandbox.run({ command: 'true' }),
  'run with a signal': (sandbox) =>
    sandbox.run({
      command: 'true',
      abortSignal: new AbortController().signal,
    }),
  spawn: (sandbox) => sandbox.spawn({ command: 'true' }),
  readFile: (sandbox) => sandbox.readFile({ path: '/etc/hostname' }),
  readBinaryFile: (sandbox) =>
    sandbox.readBinaryFile({ path: '/etc/hostname' }),
  readTextFile: (sandbox) => sandbox.readTextFile({ path: '/etc/hostname' }),
  writeFile: (sandbox) =>
    sandbox.writeFile({
      path: 'note.txt',
      content: new Blob(['note']).stream(),
    }),
  writeBinaryFile: (sandbox) =>
    sandbox.writeBinaryFile({
      path: 'note.txt',
      content: new TextEncoder().encode('note'),
    }),
  writeTextFile: (sandbox) =>
    sandbox.writeTextFile({ path: 'note.txt', content: 'note' }),
  stat: (sandbox) => sandbox.stat({ path: '/etc/hostname' }),
  listDirectory: (sandbox) => sandbox.listDirectory({ path: '/' }),
  deleteFile: (sandbox) => sandbox.deleteFile({ path: 'missing.txt' }),
} satisfies Record<string, (sandbox: SandboxSession) => PromiseLike<unknown>>;

/** Every operation of a chat sandbox handle: the session's, and `resume`. */
const operations = {
  ...sessionOperations,
  resume: (sandbox: ChatSandbox) => sandbox.resume(),
};

async function outcomesOf<T>(
  sandbox: T,
  calls: Record<string, (sandbox: T) => PromiseLike<unknown>>,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [operation, call] of Object.entries(calls)) {
    result[operation] = await Promise.resolve(call(sandbox)).then(
      () => 'resolved',
      (error: Error) =>
        error instanceof SandboxNotFoundError
          ? 'SandboxNotFoundError'
          : `${error.name}: ${error.message}`,
    );
  }
  return result;
}

function everyOf(
  calls: Record<string, unknown>,
  value: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.keys(calls).map((operation) => [operation, value]),
  );
}

/** How each operation of `sandbox` ends: resolved, or the error's class. */
export function outcomes(
  sandbox: ChatSandbox,
): Promise<Record<string, string>> {
  return outcomesOf(sandbox, operations);
}

/** The {@link outcomes} of a handle whose every operation ends with `value`. */
export function every(value: string): Record<string, string> {
  return everyOf(operations, value);
}

/** How each session operation of a one-off sandbox ends, as {@link outcomes} reports it. */
export function sessionOutcomes(
  sandbox: SandboxSession,
): Promise<Record<string, string>> {
  return outcomesOf(sandbox, sessionOperations);
}

/** The {@link sessionOutcomes} of a sandbox whose every operation ends with `value`. */
export function everySessionOperation(value: string): Record<string, string> {
  return everyOf(sessionOperations, value);
}
