import type { UIMessage } from 'ai';

import type { ChainSummary } from '../chain-summary.ts';
import type { ContextFragment } from '../fragments.ts';
import type {
  ConditionalReminder,
  ReminderResolution,
  ReminderTarget,
  WhenContext,
} from '../fragments/message/user.ts';

export type BaseWhenCtx = Omit<
  WhenContext,
  | 'content'
  | 'currentMessage'
  | 'lastAssistantMessage'
  | 'lastAssistantMessages'
>;

export interface PreparedCarrier {
  message: UIMessage;
  fragmentIndex: number;
}

export interface ReminderHandlerInput {
  pending: ContextFragment[];
  base: BaseWhenCtx;
  chain: ChainSummary;
  sharedUserMessage?: UIMessage & { role: 'user' };
}

export interface ReminderApplyInput {
  pending: ContextFragment[];
  carrier: PreparedCarrier;
  fired: ConditionalReminder[];
  resolved: ReminderResolution[];
}

export interface PreparedHandler {
  whenCtx: WhenContext;
  carrier: PreparedCarrier;
  sharedUserMessage?: UIMessage & { role: 'user' };
}

export interface ReminderTargetHandler {
  readonly target: ReminderTarget;
  prepare(input: ReminderHandlerInput): PreparedHandler | null;
  apply(input: ReminderApplyInput): void;
}
