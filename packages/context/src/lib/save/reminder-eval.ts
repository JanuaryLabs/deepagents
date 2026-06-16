import {
  type ConditionalReminder,
  type ReminderResolution,
  type WhenContext,
  resolveReminderAsync,
} from '../fragments/message/user.ts';

export interface FiredReminder {
  config: ConditionalReminder;
  resolved: ReminderResolution;
  /** Once-ids `once()` collected while this config's `when()` evaluated to fire. */
  onceIds: string[];
}

/**
 * Evaluate conditional reminders against a single `whenCtx` and return the ones
 * that fired with non-empty resolved text.
 *
 * Each predicate and each async text resolver is isolated: a throwing/rejecting
 * `when()` or reminder text is treated as "did not fire" and logged, never
 * propagated. This is the single evaluation core shared by the save pipeline
 * and the steer loop, so a misbehaving user predicate can never tear down a
 * save or an in-flight assistant turn.
 */
export async function evaluateFiredReminders(
  configs: ConditionalReminder[],
  whenCtx: WhenContext,
): Promise<FiredReminder[]> {
  if (configs.length === 0) return [];

  // Each config evaluates against its own onceCollector so once() intents never
  // leak between configs sharing one whenCtx.
  const collectors = configs.map(() => new Set<string>());
  const whenResults = await Promise.allSettled(
    // Wrap in an async thunk so a synchronously-throwing predicate becomes a
    // rejected promise (allSettled cannot catch a throw inside the map itself).
    configs.map(async (config, i) =>
      config.when({ ...whenCtx, onceCollector: collectors[i] }),
    ),
  );
  const fired: Array<{ config: ConditionalReminder; onceIds: string[] }> = [];
  for (let i = 0; i < configs.length; i++) {
    const result = whenResults[i];
    if (result.status === 'rejected') {
      console.warn('reminder when() predicate threw; treating as not fired', {
        reason: result.reason,
      });
      continue;
    }
    if (result.value === true) {
      fired.push({ config: configs[i], onceIds: [...collectors[i]] });
    }
  }
  if (fired.length === 0) return [];

  const resolutions = await Promise.allSettled(
    fired.map(({ config }) => resolveReminderAsync(config, whenCtx)),
  );
  const matched: FiredReminder[] = [];
  for (let i = 0; i < fired.length; i++) {
    const result = resolutions[i];
    if (result.status === 'rejected') {
      console.warn('reminder text resolver threw; skipping reminder', {
        reason: result.reason,
      });
      continue;
    }
    if (result.value) {
      matched.push({
        config: fired[i].config,
        resolved: result.value,
        onceIds: fired[i].onceIds,
      });
    }
  }
  return matched;
}
