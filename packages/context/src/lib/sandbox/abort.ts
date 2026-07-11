import { AsyncLocalStorage } from 'node:async_hooks';

import type { DisposableSandbox } from './types.ts';

const ambientAbortSignal = new AsyncLocalStorage<AbortSignal | undefined>();

/**
 * Set the ambient abort signal for the duration of `fn`. Inside `fn`,
 * any sandbox call going through `withAbortSignal` will receive this
 * signal via its `executeCommand` options.
 *
 * Use at the boundary where an external abort signal becomes available
 * (e.g. a tool's `execute` callback). The signal then propagates down
 * the decorator chain without explicit parameter threading.
 */
export function runWithAbortSignal<T>(
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return ambientAbortSignal.run(signal, fn);
}

/**
 * Decorator: when `executeCommand` is called without an explicit signal,
 * fills in the ambient signal set by `runWithAbortSignal`. Explicit
 * caller-provided signals take precedence. Has no effect outside a
 * `runWithAbortSignal` scope.
 *
 * This remains useful for callers that start work outside an AI SDK tool
 * execution callback. The owned bash tool passes its abort signal explicitly.
 */
export function withAbortSignal(sandbox: DisposableSandbox): DisposableSandbox {
  const decorated: DisposableSandbox = {
    async executeCommand(command, options) {
      const signal = options?.signal ?? ambientAbortSignal.getStore();
      return sandbox.executeCommand(
        command,
        signal ? { ...options, signal } : options,
      );
    },
    readFile: (path) => sandbox.readFile(path),
    writeFiles: (files) => sandbox.writeFiles(files),
    dispose: () => sandbox.dispose(),
    [Symbol.asyncDispose]() {
      return decorated.dispose();
    },
  };

  if (sandbox.spawn) {
    const innerSpawn = sandbox.spawn.bind(sandbox);
    decorated.spawn = (command, options) => {
      const signal = options?.signal ?? ambientAbortSignal.getStore();
      return innerSpawn(command, signal ? { ...options, signal } : options);
    };
  }

  return decorated;
}
