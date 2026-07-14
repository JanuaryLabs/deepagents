/**
 * Browser-focused entrypoint.
 *
 * This surface excludes server-only modules such as concrete stores and
 * sandbox adapters, and only exports APIs safe to consume in browser bundles.
 */
export * from './lib/codec/codec.ts';
export * from './lib/codec/serialized-fragments.ts';
export * from './lib/estimate.ts';
export * from './lib/fragments.ts';
export * from './lib/fragments/domain.ts';
export * from './lib/fragments/message/user.ts';
export * from './lib/fragments/reminders/src/reminders.ts';
export type {
  BaseWhenCtx,
  ConditionalReminder,
  CountSpec,
  ReminderContext,
  ReminderFragment,
  ReminderOptions,
  ReminderRange,
  ReminderResolution,
  ReminderTarget,
  ReminderText,
  SyncReminderText,
  SyntheticReminderMetadata,
  ToolOutcome,
  UserReminderMetadata,
  WhenContext,
  WhenPredicate,
} from './lib/fragments/reminders/src/types.ts';
export * from './lib/fragments/user.ts';
export * from './lib/guardrail.ts';
export * from './lib/models.generated.ts';
export * from './lib/render.ts';
export * from './lib/renderers/abstract.renderer.ts';
export * from './lib/skills/fragments.ts';
export type * from './lib/skills/types.ts';
export * from './lib/soul/fragments.ts';
export * from './lib/store/store.ts';
export * from './lib/stream-buffer.ts';
export * from './lib/stream/stream-store.ts';
export * from './lib/visualize.ts';
