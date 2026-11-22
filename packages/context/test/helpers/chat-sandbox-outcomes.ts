import { type ChatSandbox, SandboxNotFoundError } from '@deepagents/context';

/** Every operation of a chat sandbox handle, each with arguments that succeed on a live one. */
const operations = {
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
  resume: (sandbox) => sandbox.resume(),
} satisfies Record<string, (sandbox: ChatSandbox) => PromiseLike<unknown>>;

/** How each operation of `sandbox` ends: resolved, or the error's class. */
export async function outcomes(
  sandbox: ChatSandbox,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [operation, call] of Object.entries(operations)) {
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

/** The {@link outcomes} of a handle whose every operation ends with `value`. */
export function every(value: string): Record<string, string> {
  return Object.fromEntries(
    Object.keys(operations).map((operation) => [operation, value]),
  );
}
