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
 * Bridges the signature mismatch between upstream `bash-tool` (which
 * calls `sandbox.executeCommand(command)` with no options) and backends
 * that can honor cancellation. The decorator goes between upstream and
 * the inner sandbox.
 */
export function withAbortSignal(sandbox: DisposableSandbox): DisposableSandbox {
  return {
    ...sandbox,
    async executeCommand(command, options) {
      const signal = options?.signal ?? ambientAbortSignal.getStore();
      return sandbox.executeCommand(
        command,
        signal ? { ...options, signal } : options,
      );
    },
  };
}
