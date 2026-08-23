import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  History,
  type HistoryRecord,
  HistoryStatusIcon,
} from '@deepagents/devtool-history';
import { StatusBadge, cn, formatTimestamp } from '@deepagents/devtool-shadcn';
import '@deepagents/devtool-shadcn/styles.css';
import '@deepagents/devtool-traces/styles.css';
import { TracesView } from '@deepagents/devtool-traces/ui';

const copy = {
  checking: {
    message: 'Checking development runtime.',
  },
  connected: {
    message: 'Development runtime connected.',
  },
  unavailable: {
    message: 'Development runtime unavailable.',
  },
} as const;

type Status = keyof typeof copy;
type View = 'summary' | 'traces';

type Discovery = {
  traces?: { path: string };
  capabilities: {
    history: { href: string };
  };
};

type Route = {
  view: View;
  chatId?: string;
  userId?: string;
  traceId?: string;
};

function App() {
  const [status, setStatus] = useState<Status>('checking');
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [historyError, setHistoryError] = useState(false);
  const [discovery, setDiscovery] = useState<Discovery>();
  const [route, setRoute] = useState<Route>(readRoute);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('./health', { signal: controller.signal })
      .then((response) => setStatus(response.ok ? 'connected' : 'unavailable'))
      .catch(() => {
        if (!controller.signal.aborted) setStatus('unavailable');
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let interval: number | undefined;
    const connect = async () => {
      try {
        const discoveryResponse = await fetch('./zukhruf/v1/info', {
          signal: controller.signal,
        });
        if (!discoveryResponse.ok) {
          throw new Error(
            `Discovery request failed: ${discoveryResponse.status}`,
          );
        }
        const connected = (await discoveryResponse.json()) as Discovery;
        setDiscovery(connected);
        const refresh = async () => {
          try {
            const response = await fetch(
              new URL(
                connected.capabilities.history.href,
                window.location.href,
              ),
              { signal: controller.signal },
            );
            if (!response.ok) {
              throw new Error(`History request failed: ${response.status}`);
            }
            setHistory((await response.json()) as HistoryRecord[]);
            setHistoryError(false);
          } catch {
            if (!controller.signal.aborted) setHistoryError(true);
          }
        };
        await refresh();
        interval = window.setInterval(() => void refresh(), 3_000);
      } catch {
        if (!controller.signal.aborted) setHistoryError(true);
      }
    };
    void connect();
    return () => {
      controller.abort();
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const onPopState = () => setRoute(readRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const selected =
    history.find(
      ({ chatId, userId }) =>
        chatId === route.chatId && userId === route.userId,
    ) ?? history[0];

  const navigate = useCallback(
    (entry: HistoryRecord, view: View, replace: boolean, traceId?: string) => {
      const next = {
        view,
        chatId: entry.chatId,
        userId: entry.userId,
        ...(traceId === undefined ? {} : { traceId }),
      } satisfies Route;
      writeRoute(next, replace);
      setRoute(next);
    },
    [],
  );

  return (
    <div className="bg-background grid h-screen">
      <div className="grid min-h-0 grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="bg-sidebar text-sidebar-foreground flex min-h-0 flex-col border-r p-3">
          <div className="flex h-8 items-center justify-between px-2">
            <span className="text-muted-foreground text-[0.6875rem] font-semibold">
              Runs
            </span>
            <span className="text-muted-foreground font-mono text-[0.6875rem]">
              {history.length}
            </span>
          </div>
          <History.Root
            activeChatId={selected?.chatId}
            onSelect={(entry) => navigate(entry, 'summary', false)}
            className="overflow-y-auto"
          >
            {historyError && history.length === 0 ? (
              <History.Empty>Runs unavailable</History.Empty>
            ) : history.length === 0 ? (
              <History.Empty>No conversations yet</History.Empty>
            ) : (
              history.map((entry) => {
                const active = selected?.chatId === entry.chatId;
                const tracesActive = active && route.view === 'traces';
                return (
                  <History.Item
                    key={`${entry.userId}:${entry.chatId}`}
                    className={cn(active && 'bg-accent rounded-lg')}
                  >
                    <History.ItemTrigger history={entry} className="pb-0">
                      <HistoryStatusIcon status={entry.status} />
                      <span className="text-foreground truncate">
                        {entry.title ?? entry.chatId}
                      </span>
                    </History.ItemTrigger>
                    {discovery?.traces ? (
                      <button
                        type="button"
                        aria-current={tracesActive ? 'page' : undefined}
                        className={cn(
                          'text-muted-foreground hover:text-foreground ml-8 block px-2 pb-1.5 text-[0.6875rem]',
                          tracesActive && 'text-foreground',
                        )}
                        onClick={() => navigate(entry, 'traces', false)}
                      >
                        Traces
                      </button>
                    ) : null}
                  </History.Item>
                );
              })
            )}
          </History.Root>
        </aside>
        <main className="min-h-0 min-w-0">
          {selected ? (
            route.view === 'traces' && discovery?.traces ? (
              <TracesView
                conversation={selected}
                traceId={route.traceId}
                onTraceId={(traceId, replace) =>
                  navigate(selected, 'traces', replace, traceId)
                }
              />
            ) : (
              <ConversationSummary conversation={selected} />
            )
          ) : (
            <p className="text-muted-foreground p-8 text-sm">
              {copy[status].message}
            </p>
          )}
        </main>
      </div>
    </div>
  );
}

function ConversationSummary({
  conversation,
}: {
  conversation: HistoryRecord;
}) {
  return (
    <div className="max-w-2xl p-8">
      <div className="flex items-start justify-between gap-6 border-b pb-5">
        <div className="min-w-0">
          <p className="text-muted-foreground mb-1 text-xs font-medium">
            Conversation
          </p>
          <h2 className="truncate text-xl font-semibold tracking-tight">
            {conversation.title ?? conversation.chatId}
          </h2>
        </div>
        <StatusBadge status={conversation.status} />
      </div>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-5 gap-y-3 py-5 text-sm">
        <dt className="text-muted-foreground">User</dt>
        <dd className="font-mono text-xs">{conversation.userId}</dd>
        <dt className="text-muted-foreground">Chat</dt>
        <dd className="truncate font-mono text-xs">{conversation.chatId}</dd>
        <dt className="text-muted-foreground">Messages</dt>
        <dd>{conversation.messageCount}</dd>
        <dt className="text-muted-foreground">Updated</dt>
        <dd>{formatTimestamp(conversation.updatedAt)}</dd>
      </dl>
    </div>
  );
}

function readRoute(): Route {
  const params = new URLSearchParams(window.location.search);
  const chatId = params.get('chatId');
  const userId = params.get('userId');
  const traceId = params.get('traceId');
  return {
    view: params.get('view') === 'traces' ? 'traces' : 'summary',
    ...(chatId ? { chatId } : {}),
    ...(userId ? { userId } : {}),
    ...(traceId ? { traceId } : {}),
  };
}

function writeRoute(route: Route, replace: boolean) {
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('view', route.view);
  if (route.chatId) url.searchParams.set('chatId', route.chatId);
  if (route.userId) url.searchParams.set('userId', route.userId);
  if (route.traceId) url.searchParams.set('traceId', route.traceId);
  window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
