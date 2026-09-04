import {
  CircleAlertIcon,
  CircleDotIcon,
  CirclePauseIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
} from 'lucide-react';
import {
  type ReactNode,
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from 'react';

import type { ConversationStatus } from '@deepagents/experimental/zukhruf';
import type { OwnerEvent } from '@deepagents/experimental/zukhruf/http';
import { cn } from '@deepagents/react-shadcn';

export type { ConversationStatus } from '@deepagents/experimental/zukhruf';

export type HistoryRecord = {
  chatId: string;
  userId: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  status: ConversationStatus;
};

export type ConversationEvent = {
  type: 'change';
  resource: 'conversation';
  id: string;
  status: ConversationStatus;
};

export type RuntimeEvent = OwnerEvent;

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

type LiveStatuses = ReadonlyMap<string, ConversationStatus>;

const ConversationStatusContext = createContext<LiveStatuses | null>(null);

export function RuntimeEventsProvider({
  href,
  onEvent,
  children,
}: {
  href: string | undefined;
  onEvent: (event: RuntimeEvent) => void;
  children: ReactNode;
}) {
  const [statuses, setStatuses] = useState<LiveStatuses>(new Map());
  const notify = useEffectEvent(onEvent);
  useEffect(() => {
    if (!href) return;
    const source = new EventSource(href);
    const handleEvent = (message: MessageEvent<string>) => {
      const event = parseRuntimeEvent(message.data);
      if (!event) return;
      if (event.type === 'ready') {
        setStatuses(new Map());
      } else if (isConversationEvent(event)) {
        setStatuses((previous) =>
          new Map(previous).set(event.id, event.status),
        );
      }
      notify(event);
    };
    source.addEventListener('message', handleEvent);
    return () => {
      source.removeEventListener('message', handleEvent);
      source.close();
    };
  }, [href]);
  return (
    <ConversationStatusContext value={statuses}>
      {children}
    </ConversationStatusContext>
  );
}

export function useConversationStatus(
  chatId: string,
  snapshot: ConversationStatus,
): ConversationStatus {
  const statuses = use(ConversationStatusContext);
  if (!statuses) {
    throw new Error(
      'useConversationStatus must be used inside <RuntimeEventsProvider>.',
    );
  }
  return statuses.get(chatId) ?? snapshot;
}

export function isConversationEvent(
  event: RuntimeEvent,
): event is ConversationEvent {
  return (
    event.type === 'change' &&
    event.resource === 'conversation' &&
    isConversationStatus(event.status)
  );
}

function parseRuntimeEvent(data: string): RuntimeEvent | undefined {
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isRecord(event) || typeof event.type !== 'string') return undefined;
  if (event.type === 'ready') return { type: 'ready' };
  if (
    event.type !== 'change' ||
    typeof event.resource !== 'string' ||
    !event.resource ||
    typeof event.id !== 'string' ||
    !event.id
  ) {
    return undefined;
  }
  if (
    event.resource === 'conversation' &&
    !isConversationStatus(event.status)
  ) {
    return undefined;
  }
  return event as RuntimeEvent;
}

function isConversationStatus(value: unknown): value is ConversationStatus {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'idle' || value.type === 'systemError') return true;
  return (
    value.type === 'active' &&
    Array.isArray(value.activeFlags) &&
    value.activeFlags.every(
      (flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput',
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export function ChatStatusIcon({
  chatId,
  status,
}: Pick<HistoryRecord, 'chatId' | 'status'>) {
  const className = 'size-3.5 shrink-0';
  const label = conversationStatusLabel(useConversationStatus(chatId, status));
  switch (label) {
    case 'active':
      return <CircleDotIcon aria-label="Active" className={className} />;
    case 'error':
      return (
        <CircleAlertIcon
          aria-label="Error"
          className={cn(className, 'text-destructive')}
        />
      );
    case 'idle':
      return <MessageSquareIcon aria-label="idle" className={className} />;
    case 'approval':
      return (
        <CirclePauseIcon
          aria-label="Waiting on approval"
          className={className}
        />
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
