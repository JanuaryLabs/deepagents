import { type UserReminder, user } from '../fragments/message/user.ts';
import { extractPlainText } from '../text.ts';
import { requireUserUIMessage } from '../ui-message-guards.ts';
import type {
  PreparedHandler,
  ReminderApplyInput,
  ReminderHandlerInput,
  ReminderTargetHandler,
} from './reminder-target-handler.ts';

export class UserTargetHandler implements ReminderTargetHandler {
  readonly target: 'user' = 'user' as const;

  prepare({
    pending,
    base,
    chain,
  }: ReminderHandlerInput): PreparedHandler | null {
    const fragmentIndex = pending.findLastIndex(
      (fragment) => fragment.name === 'user',
    );
    if (fragmentIndex < 0) return null;

    const fragment = pending[fragmentIndex];
    if (!fragment.codec) return null;

    const message = requireUserUIMessage(
      fragment.codec.encode(),
      `Pending user fragment "${fragment.name}"`,
    );

    return {
      whenCtx: {
        ...base,
        content: extractPlainText(message),
        currentMessage: message,
        lastAssistantMessage: chain.lastAssistantMessage,
        lastAssistantMessages: chain.lastAssistantMessages,
      },
      carrier: { message, fragmentIndex },
      sharedUserMessage: message,
    };
  }

  apply({ pending, carrier, fired, resolved }: ReminderApplyInput): void {
    const reminders: UserReminder[] = resolved.map((resolution, i) => ({
      text: resolution.text,
      asPart: fired[i].asPart,
      target: 'user',
      metadata: resolution.metadata,
    }));

    const originalId = pending[carrier.fragmentIndex].id;
    const message = requireUserUIMessage(
      originalId ? { ...carrier.message, id: originalId } : carrier.message,
      'Pending user reminder carrier',
    );
    const recreated = user(message, ...reminders);
    if (originalId) recreated.id = originalId;
    pending[carrier.fragmentIndex] = recreated;
  }
}
