/**
 * Shared by every copy of this module: each subpath entry bundles its own
 * copy of a main-entry class, so `instanceof` fails across entries, and a
 * subclass replaces the class's `name` with its own.
 */
const nonRetryable = Symbol.for(
  '@deepagents/experimental/zukhruf/non-retryable',
);

/**
 * A failure that no retry can fix, such as corrupt stored state. A settle
 * follow-up (a plugin's `conversationAvailable`) throws one, or a subclass of
 * it, to have the runtime report the failure once as a process warning and
 * not run that follow-up again; every other failure is retried. Temporal's
 * non-retryable failure is the model.
 */
export class NonRetryableError extends Error {
  override readonly name: string = 'NonRetryableError';
  readonly [nonRetryable] = true;
}

/** Whether `error` is a NonRetryableError of any copy of this module. */
export function isNonRetryableError(
  error: unknown,
): error is NonRetryableError {
  return Error.isError(error) && nonRetryable in error;
}
