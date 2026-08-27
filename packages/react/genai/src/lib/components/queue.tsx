import { ListPlus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { PersistedPromptText } from '@deepagents/chat-input/browser';
import { cn } from '@deepagents/react-shadcn';

function MessageQueueRoot({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'border-border flex flex-col border-b px-2 py-1.5',
        className,
      )}
    >
      {children}
    </div>
  );
}

function MessageQueueItem({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2 px-2 py-1.5', className)}>
      {children}
    </div>
  );
}

function MessageQueueIcon({ className }: { className?: string }) {
  return (
    <ListPlus
      className={cn('text-muted-foreground size-3.5 shrink-0', className)}
    />
  );
}

function MessageQueueText({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn('min-w-0 flex-1 truncate text-sm', className)}>
      {typeof children === 'string' ? (
        <PersistedPromptText text={children} />
      ) : (
        children
      )}
    </span>
  );
}

function MessageQueueRemove({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'text-muted-foreground hover:text-foreground shrink-0 rounded p-1 transition-colors',
        className,
      )}
      aria-label="Remove queued message"
    >
      <Trash2 className="size-3.5" />
    </button>
  );
}

export const MessageQueue = {
  Root: MessageQueueRoot,
  Item: MessageQueueItem,
  Icon: MessageQueueIcon,
  Text: MessageQueueText,
  Remove: MessageQueueRemove,
};
