import type { LanguageModelUsage, UIMessage } from 'ai';

import type { ContextFragment } from '../../../fragments.ts';
import type { StoredChatData } from '../../../store/store.ts';

export interface ReminderContext {
  content: string;
  turn?: number;
  lastMessageAt?: number;
  lastMessage?: UIMessage;
  currentMessage?: UIMessage;
  chat?: StoredChatData;
  usage?: LanguageModelUsage;
  branch?: string;
  elapsed?: number;
  messageCount?: number;
  lastAssistantMessage?: UIMessage;
}

export interface ReminderResolution {
  text: string;
  metadata?: Record<string, unknown>;
}

export type SyncReminderText =
  | string
  | ((ctx: ReminderContext) => string | ReminderResolution);

export type ReminderText =
  | string
  | ((
      ctx: ReminderContext,
    ) => string | ReminderResolution | Promise<string | ReminderResolution>);

export interface WhenContext {
  turn: number;
  content: string;
  lastMessageAt?: number;
  lastMessage?: UIMessage;
  currentMessage: UIMessage;
  chat: StoredChatData;
  usage?: LanguageModelUsage;
  branch: string;
  elapsed?: number;
  messageCount: number;
  lastAssistantMessage?: UIMessage;
  lastAssistantMessages?: UIMessage[];
  /**
   * The tool call whose result is being wrapped, populated only during
   * `target: 'tool-output'` evaluation — the live call in flight, which the
   * finalized message chain cannot yet contain (`lastAssistantMessage` holds
   * prior, already-completed calls). Read it directly in a predicate to gate on
   * the executing tool's name/input/result. Undefined for `user` / `steer`.
   */
  executingTool?: { name: string; input: unknown; output: unknown };
  /**
   * Ids that a fire-once latch has already fired for in this conversation
   * (persisted synth onceIds ∪ this stream's fires). Populated only during
   * steer evaluation; `once(id)` reads it to suppress a second fire.
   */
  firedOnceIds?: ReadonlySet<string>;
  /**
   * Per-evaluation buffer that `once(id)` appends to when consulted and not yet
   * fired. The engine commits these ids — to the session and the synth — only
   * if the whole reminder fires. One fresh collector per config evaluation.
   */
  onceCollector?: Set<string>;
}

/**
 * The engine-level slice of `WhenContext` — everything that does not depend on a
 * specific carrier message. Callers add `content`/`currentMessage`/the
 * last-assistant fields once they have located the message being evaluated.
 */
export type BaseWhenCtx = Omit<
  WhenContext,
  | 'content'
  | 'currentMessage'
  | 'lastAssistantMessage'
  | 'lastAssistantMessages'
>;

export type WhenPredicate = (ctx: WhenContext) => boolean | Promise<boolean>;

export type ReminderTarget = 'user' | 'tool-output' | 'steer';

export interface SyntheticSteerMetadata {
  source: 'steer-reminder';
  firedAt: number;
  onceIds?: string[];
}

export interface ReminderOptions {
  /**
   * Predicate gating when the reminder fires. Optional for `target: 'user'`
   * (omit ⇒ always fires; pair with `once(id)` for one-time); required for
   * `steer` / `tool-output`, where a trigger-less reminder is meaningless.
   */
  when?: WhenPredicate;
  asPart?: boolean;
  target?: ReminderTarget;
}

export interface ConditionalReminder {
  text: ReminderText;
  when: WhenPredicate;
  asPart: boolean;
  target: ReminderTarget;
}

export interface UserReminderMetadata {
  id: string;
  text: string;
  target: ReminderTarget;
  partIndex: number;
  start: number;
  end: number;
  mode: 'inline' | 'part';
}

export type ReminderRange = {
  partIndex: number;
  start: number;
  end: number;
};

export type CountSpec = { gte?: number; lte?: number; eq?: number };

export type ReminderFragment = ContextFragment & {
  metadata: { reminder: ConditionalReminder };
};
