import type { ChatStatus, UIMessage } from 'ai';
import { useMemo } from 'react';

import { cn } from '@deepagents/react-shadcn';

import type { GenAIInteractiveElement } from '../../../components/InteractiveResponse.tsx';
import {
  MessageItemCtx,
  type MessagesContextValue,
  MessagesCtx,
} from '../messages-context.ts';

export function MessagesRoot({
  messages,
  className,
  components,
  status,
  children,
}: {
  messages: UIMessage[];
  className?: string;
  components?: GenAIInteractiveElement[];
  status?: ChatStatus;
  children: React.ReactNode;
}) {
  const value = useMemo<MessagesContextValue>(
    () => ({ messages, components, status }),
    [messages, components, status],
  );

  return (
    <MessagesCtx.Provider value={value}>
      <div className={cn('flex h-full flex-col', className)}>
        <div className="flex h-full min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </MessagesCtx.Provider>
  );
}

export function MessagesList({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
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

  return (
    <MessageItemCtx.Provider value={value}>
      <div className={className}>{children}</div>
    </MessageItemCtx.Provider>
  );
}
