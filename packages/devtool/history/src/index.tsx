import {
  BanIcon,
  CircleAlertIcon,
  Clock3Icon,
  Loader2Icon,
  MessageSquareIcon,
} from 'lucide-react';
import { type ReactNode, createContext, use, useMemo } from 'react';

import { cn } from '@deepagents/devtool-shadcn';

export type HistoryRecord = {
  chatId: string;
  userId: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  status: 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
};

type HistoryContextValue = {
  activeChatId: string | undefined;
  onSelect: (history: HistoryRecord) => void;
};

const HistoryContext = createContext<HistoryContextValue | null>(null);

function useHistoryContext() {
  const context = use(HistoryContext);
  if (!context) {
    throw new Error('History.* parts must be rendered inside <History.Root>.');
  }
  return context;
}

function HistoryRoot({
  activeChatId,
  onSelect,
  className,
  children,
}: {
  activeChatId: string | undefined;
  onSelect: (history: HistoryRecord) => void;
  className?: string;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ activeChatId, onSelect }),
    [activeChatId, onSelect],
  );
  return (
    <HistoryContext.Provider value={value}>
      <div className={cn('flex min-h-0 flex-col gap-1', className)}>
        {children}
      </div>
    </HistoryContext.Provider>
  );
}

function HistoryItem({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('group/history-item relative', className)}>
      {children}
    </div>
  );
}

function HistoryItemTrigger({
  history,
  className,
  children,
}: {
  history: HistoryRecord;
  className?: string;
  children: ReactNode;
}) {
  const { activeChatId, onSelect } = useHistoryContext();
  const isActive = activeChatId === history.chatId;
  return (
    <button
      type="button"
      aria-current={isActive ? 'true' : undefined}
      onClick={() => onSelect(history)}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors',
        isActive
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        className,
      )}
    >
      {children}
    </button>
  );
}

function HistoryEmpty({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('text-muted-foreground px-2 py-4 text-sm', className)}>
      {children}
    </div>
  );
}

export function HistoryStatusIcon({ status }: Pick<HistoryRecord, 'status'>) {
  const className = 'size-3.5 shrink-0';
  switch (status) {
    case 'queued':
      return <Clock3Icon aria-label="Queued" className={className} />;
    case 'running':
      return (
        <Loader2Icon
          aria-label="Running"
          className={cn(className, 'animate-spin')}
        />
      );
    case 'failed':
      return (
        <CircleAlertIcon
          aria-label="Failed"
          className={cn(className, 'text-destructive')}
        />
      );
    case 'cancelled':
      return <BanIcon aria-label="Cancelled" className={className} />;
    case 'idle':
    case 'completed':
      return <MessageSquareIcon aria-label={status} className={className} />;
  }
}

export const History = {
  Root: HistoryRoot,
  Item: HistoryItem,
  ItemTrigger: HistoryItemTrigger,
  Empty: HistoryEmpty,
} as const;
