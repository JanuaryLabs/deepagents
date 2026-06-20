import type { WhenPredicate } from '../message/user.ts';

/**
 * Durable fire-once latch, composed into a steer reminder's `when`.
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
    // firedOnceIds is wired for steer and user evaluation; its absence means
    // once() was used on a tool-output target where it cannot durably latch
    // (no persisted carrier records the fire). Throw rather than silently fire
    // every turn (the eval pipeline isolates this into "did not fire" + warning).
    if (ctx.firedOnceIds === undefined) {
      throw new Error(
        `once('${id}') is not supported on target:'tool-output' reminders`,
      );
    }
    if (ctx.firedOnceIds.has(id)) return false;
    ctx.onceCollector?.add(id);
    return true;
  };
}
