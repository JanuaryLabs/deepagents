import {
  BanIcon,
  CircleAlertIcon,
  CircleDotIcon,
  CirclePauseIcon,
  Clock3Icon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
} from 'lucide-react';
import { type ReactNode, createContext, use, useMemo } from 'react';

import { cn } from '@deepagents/react-shadcn';

export type HistoryRecord = {
  chatId: string;
  userId: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  status: 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
};

/** Mirror of the runtime's Codex-shaped conversation status. */
export type ConversationStatus =
  | { type: 'idle' }
  | {
      type: 'active';
      activeFlags: readonly ('waitingOnApproval' | 'waitingOnUserInput')[];
    }
  | { type: 'systemError' };

export function conversationStatusLabel(status: ConversationStatus) {
  switch (status.type) {
    case 'idle':
      return 'idle';
    case 'systemError':
      return 'error';
    case 'active':
      if (status.activeFlags.includes('waitingOnApproval')) return 'approval';
      if (status.activeFlags.includes('waitingOnUserInput')) return 'input';
      return 'active';
  }
}

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

export function StatusIcon({
  status,
}: {
  status: HistoryRecord['status'] | ConversationStatus;
}) {
  const className = 'size-3.5 shrink-0';
  const label =
    typeof status === 'string' ? status : conversationStatusLabel(status);
  switch (label) {
    case 'queued':
      return <Clock3Icon aria-label="Queued" className={className} />;
    case 'running':
    case 'active':
      return (
        <CircleDotIcon
          aria-label={label === 'running' ? 'Running' : 'Active'}
          className={className}
        />
      );
    case 'failed':
    case 'error':
      return (
        <CircleAlertIcon
          aria-label={label === 'failed' ? 'Failed' : 'Error'}
          className={cn(className, 'text-destructive')}
        />
      );
    case 'cancelled':
      return <BanIcon aria-label="Cancelled" className={className} />;
    case 'idle':
    case 'completed':
      return <MessageSquareIcon aria-label={label} className={className} />;
    case 'approval':
      return (
        <CirclePauseIcon aria-label="Waiting on approval" className={className} />
      );
    case 'input':
      return (
        <MessageCircleQuestionIcon
          aria-label="Waiting on user input"
          className={className}
        />
      );
  }
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'text-muted-foreground rounded-md border px-2 py-1 font-mono text-[0.6875rem] capitalize',
        (status === 'failed' || status === 'error') &&
          'text-destructive border-destructive/30',
      )}
    >
      {status}
    </span>
  );
}

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatTimestamp(value: number | string) {
  return dateTime.format(new Date(value));
}

export const History = {
  Root: HistoryRoot,
  Item: HistoryItem,
  ItemTrigger: HistoryItemTrigger,
  Empty: HistoryEmpty,
} as const;
