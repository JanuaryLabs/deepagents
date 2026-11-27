import { cn } from 'cn';
import { Braces, Check, Copy, RefreshCw } from 'lucide-react';
import { Children, type ReactNode } from 'react';

import { ChatActionButton } from '../../../components/ChatAction.tsx';
import { extractAssistantRawText } from '../../../copy/assistant-snapshot.tsx';
import { useGenaiMessages } from '../../../i18n/provider.tsx';
import { useCopyFeedback } from '../../../ui/use-copy-feedback.ts';
import { useAgentMessages } from '../../agent-context.tsx';
import {
  useMessageItem,
  useMessagesContext,
  useMessagesStatus,
} from '../messages-context.ts';

function useMessageComplete() {
  const { index } = useMessageItem();
  const { messages } = useMessagesContext();
  const status = useMessagesStatus();
  const isLastMessage = index === messages.length - 1;
  const isBusy =
    status === 'submitted' || status === 'streaming' || status === 'error';
  return !(isLastMessage && isBusy);
}

export function MessagesActions({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const complete = useMessageComplete();
  if (!complete || Children.toArray(children).length === 0) return null;

  return (
    <div
      data-copy-exclude="assistant-snapshot"
      className={cn('mt-1 flex items-center gap-0.5', className)}
    >
      {children}
    </div>
  );
}

export function CopyAssistantMessageAction({
  className,
}: {
  className?: string;
}) {
  const { message } = useMessageItem();
  const [copied, copy] = useCopyFeedback();
  const t = useGenaiMessages();

  return (
    <ChatActionButton
      aria-label={t(copied ? 'message.copied' : 'message.copy')}
      className={cn('p-1.5', className)}
      onClick={() => void copy(extractAssistantRawText(message))}
      icon={
        copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />
      }
    />
  );
}

export function RegenerateAction({ className }: { className?: string }) {
  const { message } = useMessageItem();
  const { regenerate } = useAgentMessages();
  const t = useGenaiMessages();

  return (
    <ChatActionButton
      aria-label={t('message.regenerate')}
      className={cn('p-1.5', className)}
      onClick={() => void regenerate({ messageId: message.id })}
      icon={<RefreshCw className="size-3.5" />}
    />
  );
}

export function CopyAssistantMessageJsonAction({
  className,
}: {
  className?: string;
}) {
  const { message } = useMessageItem();
  const [copied, copy] = useCopyFeedback();
  const t = useGenaiMessages();

  return (
    <ChatActionButton
      aria-label={t(copied ? 'message.copied' : 'message.copyDebugJson')}
      className={cn('p-1.5', className)}
      onClick={() => void copy(JSON.stringify(message, null, 2))}
      icon={
        copied ? (
          <Check className="size-3.5" />
        ) : (
          <Braces className="size-3.5" />
        )
      }
    />
  );
}
