import {
  History,
  type HistoryRecord,
  HistoryStatusIcon,
} from '@/components/history';
import { cn } from '@/lib/utils';
import {
  AlertCircleIcon,
  BotIcon,
  BracesIcon,
  ChevronRightIcon,
  FunctionSquareIcon,
  Loader2Icon,
} from 'lucide-react';
import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

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
type RecordingState = 'recorded' | 'not-recorded';

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

type TraceSummary = {
  id: string;
  chatId: string;
  userId: string;
  streamId: string;
  agentName: string;
  agentPath: string;
  workflowName: string;
  startedAt: string | null;
  endedAt: string | null;
  status: HistoryRecord['status'];
  stepCount: number;
  finishReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
  recording: { inputs: RecordingState; outputs: RecordingState };
};

type TraceSpan = {
  id: string;
  traceId: string;
  parentId: string | null;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  type: string;
  name: string;
  input?: unknown;
  output?: unknown;
  usage?: unknown;
  error?: unknown;
  data: Record<string, unknown>;
};

type TraceDetail = TraceSummary & { spans: TraceSpan[] };

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
    (entry: HistoryRecord, view: View, traceId?: string, replace = false) => {
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
            onSelect={(entry) => navigate(entry, 'summary')}
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
                        onClick={() => navigate(entry, 'traces')}
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
                  navigate(selected, 'traces', traceId, replace)
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

function TracesView({
  conversation,
  traceId,
  onTraceId,
}: {
  conversation: HistoryRecord;
  traceId?: string;
  onTraceId: (traceId: string, replace?: boolean) => void;
}) {
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [detail, setDetail] = useState<TraceDetail>();
  const [selectedSpanId, setSelectedSpanId] = useState<string>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch(traceListUrl(conversation), {
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(`Trace request failed: ${response.status}`);
        const next = (await response.json()) as TraceSummary[];
        setTraces(next);
        setError(false);
        setLoading(false);
        if (next.length > 0 && !next.some(({ id }) => id === traceId)) {
          onTraceId(next[0].id, true);
        }
      } catch {
        if (!controller.signal.aborted) {
          setError(true);
          setLoading(false);
        }
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 3_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [conversation, onTraceId, traceId]);

  useEffect(() => {
    if (!traceId) return;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch(traceDetailUrl(conversation, traceId), {
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(`Trace detail failed: ${response.status}`);
        const next = (await response.json()) as TraceDetail;
        setDetail(next);
        setSelectedSpanId((current) =>
          next.spans.some(({ id }) => id === current)
            ? current
            : next.spans[0]?.id,
        );
        setError(false);
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 3_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [conversation, traceId]);

  const activeDetail = detail?.id === traceId ? detail : undefined;
  const selectedSpan = activeDetail?.spans.find(
    ({ id }) => id === selectedSpanId,
  );

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)]">
      <div className="flex items-start justify-between gap-6 border-b px-6 py-4">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold tracking-tight">
            {conversation.title ?? conversation.chatId}
          </h2>
          <p className="text-muted-foreground mt-1 text-xs">
            Traces · {traces.length} {traces.length === 1 ? 'turn' : 'turns'}
          </p>
        </div>
        <StatusBadge status={activeDetail?.status ?? conversation.status} />
      </div>
      <div className="flex items-center gap-3 border-b px-6 py-3">
        <label
          htmlFor="trace-selector"
          className="text-muted-foreground text-xs font-medium"
        >
          Trace
        </label>
        <select
          id="trace-selector"
          value={traceId ?? ''}
          disabled={traces.length === 0}
          onChange={(event) => onTraceId(event.target.value)}
          className="bg-background max-w-xl min-w-0 flex-1 rounded-md border px-3 py-1.5 font-mono text-xs"
        >
          {traces.map((trace, index) => (
            <option key={trace.id} value={trace.id}>
              {index === 0 ? 'Latest · ' : ''}
              {trace.startedAt
                ? formatTimestamp(trace.startedAt)
                : 'Starting'}{' '}
              · {formatDuration(trace)} · {capitalize(trace.status)}
            </option>
          ))}
        </select>
      </div>
      {loading ? (
        <TraceState icon={<Loader2Icon className="size-4 animate-spin" />}>
          Loading traces
        </TraceState>
      ) : error ? (
        <TraceState
          icon={<AlertCircleIcon className="text-destructive size-4" />}
        >
          Traces unavailable
        </TraceState>
      ) : traces.length === 0 ? (
        <TraceState icon={<BracesIcon className="size-4" />}>
          No traces recorded for this conversation yet
        </TraceState>
      ) : activeDetail && activeDetail.spans.length > 0 ? (
        <div className="grid min-h-0 grid-cols-[minmax(32rem,1fr)_22rem]">
          <Waterfall
            trace={activeDetail}
            selectedSpanId={selectedSpanId}
            onSelectSpan={setSelectedSpanId}
          />
          <SpanInspector
            key={selectedSpan?.id}
            trace={activeDetail}
            span={selectedSpan}
          />
        </div>
      ) : activeDetail ? (
        <TraceState icon={<Loader2Icon className="size-4 animate-spin" />}>
          Trace starting
        </TraceState>
      ) : (
        <TraceState icon={<Loader2Icon className="size-4 animate-spin" />}>
          Loading trace
        </TraceState>
      )}
    </div>
  );
}

function Waterfall({
  trace,
  selectedSpanId,
  onSelectSpan,
}: {
  trace: TraceDetail;
  selectedSpanId?: string;
  onSelectSpan: (id: string) => void;
}) {
  const start = Math.min(
    ...trace.spans.map(({ startedAt }) => Date.parse(startedAt)),
  );
  const end = Math.max(
    start + 1,
    ...trace.spans.map(({ endedAt }) =>
      Date.parse(endedAt ?? trace.startedAt ?? trace.spans[0].startedAt),
    ),
  );
  const total = end - start;
  const depths = useMemo(() => spanDepths(trace.spans), [trace.spans]);

  return (
    <section className="min-h-0 overflow-auto" aria-label="Trace waterfall">
      <div className="min-w-[46rem]">
        <div className="text-muted-foreground bg-background sticky top-0 z-10 grid grid-cols-[16rem_minmax(30rem,1fr)] border-b text-[0.6875rem]">
          <span className="px-4 py-2 font-medium">SPAN</span>
          <div className="relative mr-5 h-8 font-mono">
            {Array.from({ length: 5 }, (_, index) => (
              <span
                key={index}
                className="absolute top-2 -translate-x-1/2"
                style={{ left: `${index * 25}%` }}
              >
                {formatMilliseconds((total * index) / 4)}
              </span>
            ))}
          </div>
        </div>
        {trace.spans.map((span) => {
          const spanStart = Date.parse(span.startedAt);
          const spanEnd = span.endedAt
            ? Date.parse(span.endedAt)
            : Math.max(spanStart, end);
          const left = ((spanStart - start) / total) * 100;
          const width = Math.max(((spanEnd - spanStart) / total) * 100, 0.8);
          const selected = selectedSpanId === span.id;
          return (
            <button
              key={span.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelectSpan(span.id)}
              className={cn(
                'hover:bg-muted/60 grid w-full grid-cols-[16rem_minmax(30rem,1fr)] border-b text-left transition-colors',
                selected && 'bg-muted',
              )}
            >
              <span
                className="flex min-w-0 items-center gap-2 px-4 py-3 text-xs"
                style={{
                  paddingLeft: `${16 + (depths.get(span.id) ?? 0) * 18}px`,
                }}
              >
                {spanIcon(span)}
                <span className="truncate">
                  <span className="text-muted-foreground capitalize">
                    {span.type}
                  </span>{' '}
                  · {span.name}
                </span>
              </span>
              <span className="relative my-3 mr-5 h-4">
                <span
                  className={cn(
                    'bg-foreground/75 absolute top-1 h-2 rounded-sm',
                    span.status === 'running' && 'trace-running',
                    span.status === 'failed' && 'bg-destructive',
                  )}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function SpanInspector({
  trace,
  span,
}: {
  trace: TraceDetail;
  span?: TraceSpan;
}) {
  const [tab, setTab] = useState<'overview' | 'input' | 'output' | 'raw'>(
    'overview',
  );

  if (!span) {
    return (
      <aside className="text-muted-foreground border-l p-5 text-sm">
        Select a span to inspect it.
      </aside>
    );
  }

  return (
    <aside className="bg-background grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] border-l">
      <div className="border-b p-5">
        <p className="text-muted-foreground mb-1 text-[0.6875rem] font-semibold tracking-[0.12em] uppercase">
          {span.type}
        </p>
        <h3 className="truncate text-sm font-semibold">{span.name}</h3>
        <p className="text-muted-foreground mt-1 font-mono text-xs">
          {formatSpanDuration(span)}
        </p>
      </div>
      <div className="flex gap-1 border-b px-3 pt-2" role="tablist">
        {(['overview', 'input', 'output', 'raw'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              'text-muted-foreground border-b-2 border-transparent px-2 py-2 text-xs capitalize',
              tab === value && 'text-foreground border-foreground',
            )}
          >
            {value}
          </button>
        ))}
      </div>
      <div className="min-h-0 overflow-auto p-5 text-xs">
        {tab === 'overview' ? (
          <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-3">
            <dt className="text-muted-foreground">Status</dt>
            <dd className="capitalize">{span.status}</dd>
            <dt className="text-muted-foreground">Started</dt>
            <dd>{formatTimestamp(span.startedAt)}</dd>
            <dt className="text-muted-foreground">Duration</dt>
            <dd>{formatSpanDuration(span)}</dd>
            {'usage' in span && span.usage !== undefined ? (
              <>
                <dt className="text-muted-foreground">Usage</dt>
                <dd className="font-mono">{inlineJson(span.usage)}</dd>
              </>
            ) : null}
            {span.error !== undefined ? (
              <>
                <dt className="text-destructive">Error</dt>
                <dd className="text-destructive break-words">
                  {inlineJson(span.error)}
                </dd>
              </>
            ) : null}
          </dl>
        ) : tab === 'raw' ? (
          <JsonValue value={span} />
        ) : (
          <Payload
            state={
              tab === 'input' ? trace.recording.inputs : trace.recording.outputs
            }
            value={tab === 'input' ? span.input : span.output}
            kind={tab}
          />
        )}
      </div>
    </aside>
  );
}

function Payload({
  state,
  value,
  kind,
}: {
  state: RecordingState;
  value: unknown;
  kind: 'input' | 'output';
}) {
  if (state === 'not-recorded') {
    return (
      <p className="text-muted-foreground">{capitalize(kind)} not recorded.</p>
    );
  }
  return value === undefined ? (
    <p className="text-muted-foreground">
      No {kind} was emitted for this span.
    </p>
  ) : (
    <JsonValue value={value} />
  );
}

function JsonValue({ value }: { value: unknown }) {
  return (
    <pre className="font-mono text-[0.6875rem] leading-5 break-words whitespace-pre-wrap">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function TraceState({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="text-muted-foreground flex min-h-0 items-center justify-center gap-2 p-8 text-sm">
      {icon}
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'text-muted-foreground rounded-md border px-2 py-1 font-mono text-[0.6875rem] capitalize',
        status === 'failed' && 'text-destructive border-destructive/30',
      )}
    >
      {status}
    </span>
  );
}

function spanIcon(span: TraceSpan) {
  const className = cn(
    'text-muted-foreground size-3.5 shrink-0',
    span.status === 'failed' && 'text-destructive',
  );
  switch (span.type) {
    case 'agent':
      return <BotIcon className={className} aria-hidden="true" />;
    case 'function':
      return <FunctionSquareIcon className={className} aria-hidden="true" />;
    default:
      return <ChevronRightIcon className={className} aria-hidden="true" />;
  }
}

function spanDepths(spans: TraceSpan[]) {
  const byId = new Map(spans.map((span) => [span.id, span]));
  const depths = new Map<string, number>();
  const depth = (span: TraceSpan): number => {
    const known = depths.get(span.id);
    if (known !== undefined) return known;
    const parent = span.parentId ? byId.get(span.parentId) : undefined;
    const value = parent ? depth(parent) + 1 : 0;
    depths.set(span.id, value);
    return value;
  };
  for (const span of spans) depth(span);
  return depths;
}

function traceListUrl(conversation: HistoryRecord) {
  const url = new URL(
    `./api/history/${encodeURIComponent(conversation.chatId)}/traces`,
    window.location.href,
  );
  url.searchParams.set('userId', conversation.userId);
  return url;
}

function traceDetailUrl(conversation: HistoryRecord, traceId: string) {
  const url = new URL(
    `./api/history/${encodeURIComponent(conversation.chatId)}/traces/${encodeURIComponent(traceId)}`,
    window.location.href,
  );
  url.searchParams.set('userId', conversation.userId);
  return url;
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

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatTimestamp(value: number | string) {
  return dateTime.format(new Date(value));
}

function formatDuration(trace: Pick<TraceSummary, 'startedAt' | 'endedAt'>) {
  if (!trace.startedAt) return '—';
  if (!trace.endedAt) return 'Running';
  const start = Date.parse(trace.startedAt);
  const end = Date.parse(trace.endedAt);
  return formatMilliseconds(end - start);
}

function formatSpanDuration(span: TraceSpan) {
  if (!span.endedAt) return 'Running';
  const end = Date.parse(span.endedAt);
  return formatMilliseconds(end - Date.parse(span.startedAt));
}

function formatMilliseconds(value: number) {
  if (value < 1_000) return `${Math.max(0, Math.round(value))}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)}s`;
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function inlineJson(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
