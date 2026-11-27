import { MessageScrollerContent, MessageScrollerItem } from '@zukhruf/shadcn';
import type { ChatStatus, UIMessage } from 'ai';
import { cn } from 'cn';
import { use, useMemo } from 'react';

import type { GenAIInteractiveElement } from '../../../components/InteractiveResponse.tsx';
import { ChatBotScrollerContext } from '../../chat-bot-scroller.ts';
import {
  MessageItemContext,
  MessagesContext,
  type MessagesContextValue,
} from '../messages-context.ts';

export function MessagesRoot({
  messages,
  className,
  elements,
  citation,
  status,
  children,
}: {
  messages: UIMessage[];
  className?: string;
  elements?: GenAIInteractiveElement[];
  citation?: MessagesContextValue['citation'];
  status?: ChatStatus;
  children: React.ReactNode;
}) {
  const value = useMemo<MessagesContextValue>(
    () => ({ messages, elements, citation, status }),
    [messages, elements, citation, status],
  );

  return (
    <MessagesContext value={value}>
      <div className={cn('flex h-full flex-col', className)}>
        <div className="flex h-full min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </MessagesContext>
  );
}

export function MessagesList({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  // Under ChatBot the list is the scroller's content: it reads the messages
  // as its direct children to find the user message that starts a turn.
  const inChatBot = use(ChatBotScrollerContext);
  if (inChatBot) {
    return (
      <MessageScrollerContent className={cn('h-auto min-h-0 gap-4', className)}>
        {children}
      </MessageScrollerContent>
    );
  }
  return <div className={cn('flex flex-col gap-4', className)}>{children}</div>;
}

export function MessagesItem({
  message,
  index,
  className,
  children,
}: {
  message: UIMessage;
  index: number;
  className?: string;
  children: React.ReactNode;
}) {
  const value = useMemo(() => ({ message, index }), [message, index]);
  const inChatBot = use(ChatBotScrollerContext);

  return (
    <MessageItemContext value={value}>
      {inChatBot ? (
        <MessageScrollerItem
          messageId={message.id}
          scrollAnchor={message.role === 'user'}
          className={className}
        >
          {children}
        </MessageScrollerItem>
      ) : (
        <div className={className}>{children}</div>
      )}
    </MessageItemContext>
  );
}
