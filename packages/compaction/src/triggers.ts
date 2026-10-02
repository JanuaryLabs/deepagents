import type { ModelMessage } from 'ai';

/** The current model context, after applying any saved compaction checkpoint. */
export interface CompactionTriggerContext {
  readonly messages: readonly ModelMessage[];
  /** Estimated prepared input tokens, including messages, instructions and tools, excluding output. */
  readonly tokens: number;
  /** Age since an observed cache read/write began; absent when reuse is unknown. */
  readonly cacheAgeMs?: number;
  /** Retention inferred from the successful provider request; absent when unknown. */
  readonly cacheRetentionMs?: number;
}

/** Inspect the snapshot without modifying it. Rejections propagate to the caller. */
export type CompactionTrigger = (
  context: CompactionTriggerContext,
) => boolean | Promise<boolean>;

/** Match when estimated input tokens are strictly greater than the threshold. */
export function tokensExceed(threshold: number): CompactionTrigger {
  if (!Number.isSafeInteger(threshold) || threshold < 1) {
    throw new RangeError(
      'tokensExceed: threshold must be a positive safe integer.',
    );
  }
  return ({ tokens }) => tokens > threshold;
}

/** Count all model messages, including summaries and tool messages, not UI turns. */
export function messagesExceed(threshold: number): CompactionTrigger {
  if (!Number.isSafeInteger(threshold) || threshold < 1) {
    throw new RangeError(
      'messagesExceed: threshold must be a positive safe integer.',
    );
  }
  return ({ messages }) => messages.length > threshold;
}

/** Use the observed provider policy, or an explicit override for a custom provider. */
export function cacheLikelyCold(options?: {
  retentionMs: number;
}): CompactionTrigger {
  if (
    options !== undefined &&
    (!Number.isSafeInteger(options.retentionMs) || options.retentionMs < 1)
  ) {
    throw new RangeError(
      'cacheLikelyCold: retentionMs must be a positive safe integer.',
    );
  }
  return ({ cacheAgeMs, cacheRetentionMs }) => {
    const retentionMs = options?.retentionMs ?? cacheRetentionMs;
    return (
      cacheAgeMs !== undefined &&
      retentionMs !== undefined &&
      cacheAgeMs >= retentionMs
    );
  };
}
