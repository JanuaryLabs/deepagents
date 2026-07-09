import type { HookEventName, HookPredicate } from '../types.ts';

export const eventIs =
  (...events: HookEventName[]): HookPredicate =>
  (ctx) =>
    events.includes(ctx.hook_event_name as HookEventName);
