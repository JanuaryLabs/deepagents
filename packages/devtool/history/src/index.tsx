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

import type {
  ChildActivity,
  ChildProgress,
  ConversationStatus,
} from '@deepagents/experimental/zukhruf';
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
  children?: readonly ChildProgress[];
};

export type ConversationEvent = {
  type: 'change';
  resource: 'conversation';
  id: string;
  status: ConversationStatus;
  child?: ChildProgress;
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

type LiveStatuses = ReadonlyMap<string, ConversationEvent>;

const ConversationStatusContext = createContext<LiveStatuses | null>(null);
const RuntimeHistoryContext = createContext<readonly HistoryRecord[]>([]);

export function RuntimeEventsProvider({
  href,
  onEvent,
  history = [],
  children,
}: {
  href: string | undefined;
  onEvent: (event: RuntimeEvent) => void;
  history?: readonly HistoryRecord[];
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
        setStatuses((previous) => new Map(previous).set(event.id, event));
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
      <RuntimeHistoryContext value={history}>{children}</RuntimeHistoryContext>
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
  return statuses.get(chatId)?.status ?? snapshot;
}

const childStateLabels: Record<ChildProgress['state'], string> = {
  pending: 'Pending',
  queued: 'Queued',
  running: 'Running',
  waitingOnApproval: 'Waiting on approval',
  waitingOnUserInput: 'Waiting on user input',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

const activityLabels: Record<ChildActivity['type'], string> = {
  spawn: 'Spawned',
  message: 'Message sent',
  followup: 'Follow-up sent',
  interrupt: 'Interrupt accepted',
  completion: 'Turn finished',
};

/** One row per child in the selected project, refreshed by the owner stream. */
export function ChildProgressList({
  treeId,
  snapshot = [],
}: {
  treeId: string;
  snapshot?: readonly ChildProgress[];
}) {
  const events = use(ConversationStatusContext);
  const history = use(RuntimeHistoryContext);
  const saved =
    history.find((record) => record.chatId === treeId)?.children ?? snapshot;
  const children = new Map(
    saved
      .filter((child) => child.treeId === treeId)
      .map((child) => [child.chatId, child]),
  );
  for (const event of events?.values() ?? []) {
    if (event.child?.treeId === treeId) children.set(event.id, event.child);
  }
  if (children.size === 0) return null;
  return (
    <section aria-label="Child agents" className="border-t px-6 py-3">
      <h2 className="mb-2 text-sm font-medium">Child agents</h2>
      <ul className="space-y-2">
        {[...children.values()]
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((child) => {
            const latest = Object.values(child.activities).sort(
              (a, b) => b.at - a.at,
            )[0];
            return (
              <li
                key={child.chatId}
                className="flex items-center justify-between gap-4 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs">{child.path}</p>
                  {latest && (
                    <p className="text-muted-foreground text-xs">
                      {activityLabels[latest.type]} · {latest.actorPath} →{' '}
                      {latest.targetPath}
                    </p>
                  )}
                </div>
                <StatusBadge status={childStateLabels[child.state]} />
              </li>
            );
          })}
      </ul>
    </section>
  );
}

export function isConversationEvent(
  event: RuntimeEvent,
): event is ConversationEvent {
  return (
    event.type === 'change' &&
    event.resource === 'conversation' &&
    isConversationStatus(event.status) &&
    (event.child === undefined ||
      (isChildProgress(event.child) && event.child.chatId === event.id))
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
    (!isConversationStatus(event.status) ||
      (event.child !== undefined &&
        (!isChildProgress(event.child) || event.child.chatId !== event.id)))
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

function isChildProgress(value: unknown): value is ChildProgress {
  if (
    !isRecord(value) ||
    !isRecord(value.activities) ||
    !['chatId', 'treeId', 'path', 'parentChatId', 'declarationName'].every(
      (key) => typeof value[key] === 'string',
    ) ||
    typeof value.state !== 'string' ||
    !Object.hasOwn(childStateLabels, value.state)
  )
    return false;
  return Object.entries(value.activities).every(
    ([kind, activity]) =>
      Object.hasOwn(activityLabels, kind) &&
      isRecord(activity) &&
      activity.type === kind &&
      typeof activity.at === 'number' &&
      Number.isFinite(activity.at) &&
      (activity.outcome === undefined ||
        ['completed', 'failed', 'cancelled'].includes(
          activity.outcome as string,
        )) &&
      ['id', 'actorPath', 'targetPath', 'streamId'].every(
        (key) => typeof activity[key] === 'string',
      ),
  );
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
