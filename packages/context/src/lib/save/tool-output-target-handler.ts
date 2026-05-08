import { assistant } from '../fragments.ts';
import {
  applyToolOutputRemindersToMessage,
  findSingleOutputAvailableToolPart,
  mergeReminderMetadata,
} from '../fragments/message/user.ts';
import { extractPlainText } from '../text.ts';
import { requireUIMessage } from '../ui-message-guards.ts';
import type {
  PreparedHandler,
  ReminderApplyInput,
  ReminderHandlerInput,
  ReminderTargetHandler,
} from './reminder-target-handler.ts';

export class ToolOutputTargetHandler implements ReminderTargetHandler {
  readonly target: 'tool-output' = 'tool-output' as const;

  prepare({
    pending,
    base,
    chain,
    sharedUserMessage,
  }: ReminderHandlerInput): PreparedHandler | null {
    const fragmentIndex = pending.findLastIndex(
      (fragment) => fragment.name === 'assistant',
    );
    if (fragmentIndex < 0) return null;

    const fragment = pending[fragmentIndex];
    if (!fragment.codec) return null;

    const currentMessage = sharedUserMessage ?? chain.lastMessage;
    if (!currentMessage) return null;

    const message = requireUIMessage(
      fragment.codec.encode(),
      `Pending assistant fragment "${fragment.name}"`,
    );

    if (!findSingleOutputAvailableToolPart(message)) return null;

    return {
      whenCtx: {
        ...base,
        content: extractPlainText(currentMessage),
        currentMessage,
        lastAssistantMessage: message,
        lastAssistantMessages: [
          ...(chain.lastAssistantMessages ?? []),
          message,
        ],
      },
      carrier: { message, fragmentIndex },
    };
  }

  apply({ pending, carrier, resolved }: ReminderApplyInput): void {
    const reminders = resolved.map((resolution) => ({
      text: resolution.text,
      metadata: resolution.metadata,
    }));
    const metadata = applyToolOutputRemindersToMessage(
      carrier.message,
      reminders,
    );
    mergeReminderMetadata(carrier.message, metadata);

    const originalId = pending[carrier.fragmentIndex].id;
    const message = originalId
      ? { ...carrier.message, id: originalId }
      : carrier.message;
    const updated = assistant(message);
    if (originalId) updated.id = originalId;
    pending[carrier.fragmentIndex] = updated;
  }
}
