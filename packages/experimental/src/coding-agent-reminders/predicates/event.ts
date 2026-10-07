import type { HookEventName, HookPredicate } from '../types.ts';

export const eventIs =
  (...events: HookEventName[]): HookPredicate =>
  (ctx) =>
    events.some((event) => event === ctx.hook_event_name);
