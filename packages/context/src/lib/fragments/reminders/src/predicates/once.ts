import type { WhenPredicate } from '../types.ts';

/**
 * Durable fire-once latch composed into a reminder's `when`.
 *
 * Two effects, both on `ctx` and nothing else:
 * - READ: returns false once `id` has fired in this conversation (the persisted
 *   synth carries the id, so suppression survives restarts).
 * - INTENT: while not-yet-fired, appends `id` to `ctx.onceCollector` — "latch
 *   this if the whole reminder fires". The actual commit is the engine's, gated
 *   on the reminder firing, so order inside `and`/`or` never matters and a
 *   short-circuited evaluation (where `once` is never reached) latches nothing.
 *
 * @example
 * ```ts
 * reminder('recap', {
 *   when: and(elapsedExceeds(40 * 60_000), once('recap')),
 *   target: 'steer',
 * });
 * ```
 */
export function once(id: string): WhenPredicate {
  if (id.trim().length === 0) {
    throw new Error('once(id) requires a non-empty id');
  }
  return (ctx) => {
    // All persisted reminder targets wire firedOnceIds. Its absence means this
    // predicate is being evaluated outside the reminder engine contract.
    if (ctx.firedOnceIds === undefined) {
      throw new Error(`once('${id}') requires durable reminder context`);
    }
    if (ctx.firedOnceIds.has(id)) return false;
    ctx.onceCollector?.add(id);
    return true;
  };
}
