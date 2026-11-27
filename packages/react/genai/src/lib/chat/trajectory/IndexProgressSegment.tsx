import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@zukhruf/shadcn';
import type { UIMessage } from 'ai';
import { cn } from 'cn';
import {
  Fragment,
  type ReactNode,
  createContext,
  use,
  useMemo,
  useState,
} from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';

import { TextShimmer } from '../../components/text-shimmer.tsx';
import { type GenaiTranslate, useGenaiMessages } from '../../i18n/provider.tsx';
import {
  CompactDisclosureChevron,
  compactDisclosureTriggerClass,
} from './compact-disclosure.tsx';

const INDEX_PROGRESS_PART_TYPE = 'data-text2sql-index-progress';

const STICK_TO_BOTTOM_OPTS = {
  initial: 'instant',
  resize: 'instant',
} as const;

export type IndexProgressEventType =
  | 'index:start'
  | 'index:end'
  | 'adapter:start'
  | 'adapter:end'
  | 'adapter:cache-hit'
  | 'adapter:cache-miss'
  | 'phase:start'
  | 'phase:progress'
  | 'phase:end'
  | 'adapter:error'
  | 'index:error';

export type IndexProgressEvent = {
  type: IndexProgressEventType;
  adapter?: string;
  phase?: string;
  table?: string;
  message: string;
  current?: number;
  total?: number;
};

type AdapterProgress = {
  name: string;
  phase?: string;
  table?: string;
  current?: number;
  total?: number;
};

type FailedAdapterState = AdapterProgress & {
  status: 'error';
  errorMessage: string;
};

type AdapterState =
  | (AdapterProgress & { status: 'queued' | 'running' | 'cache-hit' | 'fresh' })
  | FailedAdapterState;

type AdapterStatus = AdapterState['status'];

type IndexState = {
  adapters: AdapterState[];
  totalAdapters?: number;
} & (
  { status: 'running' | 'complete' } | { status: 'error'; errorMessage: string }
);

type GroupedProgressEvents = {
  byAdapter: Map<string, IndexProgressEvent[]>;
  globalEvents: IndexProgressEvent[];
};

type ProgressOpenStatus = IndexState['status'] | AdapterStatus;

type OpenOverride = {
  key: string;
  open: boolean;
};

function isIndexProgressPart(
  part: UIMessage['parts'][number],
): part is UIMessage['parts'][number] & {
  type: typeof INDEX_PROGRESS_PART_TYPE;
  data: IndexProgressEvent;
} {
  return part.type === INDEX_PROGRESS_PART_TYPE;
}

export function getIndexProgressEvents(
  message: UIMessage,
): IndexProgressEvent[] {
  return message.parts.filter(isIndexProgressPart).map((part) => part.data);
}

function aggregateEvents(events: IndexProgressEvent[]): IndexState {
  const byName = new Map<string, AdapterState>();
  let outcome:
    | { status: 'running' | 'complete' }
    | { status: 'error'; errorMessage: string } = { status: 'running' };
  let totalAdapters: number | undefined;

  const adapter = (name: string): AdapterState =>
    byName.get(name) ?? { name, status: 'queued' };
  const progress = (name: string, patch: Omit<AdapterProgress, 'name'>) => {
    byName.set(name, { ...adapter(name), ...patch });
  };
  const settle = (
    name: string,
    next:
      | { status: 'queued' | 'running' | 'cache-hit' | 'fresh' }
      | { status: 'error'; errorMessage: string },
  ) => {
    const { phase, table, current, total } = adapter(name);
    byName.set(name, { name, phase, table, current, total, ...next });
  };

  for (const event of events) {
    switch (event.type) {
      case 'index:start':
        totalAdapters = event.total;
        outcome = { status: 'running' };
        break;
      case 'adapter:start':
        if (event.adapter) settle(event.adapter, { status: 'running' });
        break;
      case 'adapter:cache-hit':
        if (event.adapter) settle(event.adapter, { status: 'cache-hit' });
        break;
      case 'adapter:cache-miss':
        if (event.adapter) settle(event.adapter, { status: 'running' });
        break;
      case 'phase:start':
      case 'phase:progress':
      case 'phase:end':
        if (event.adapter) {
          progress(event.adapter, {
            phase: event.phase,
            table: event.table,
            current: event.current,
            total: event.total,
          });
        }
        break;
      case 'adapter:end':
        if (event.adapter) {
          const prev = byName.get(event.adapter);
          if (prev?.status !== 'cache-hit' && prev?.status !== 'error') {
            settle(event.adapter, { status: 'fresh' });
          }
        }
        break;
      case 'adapter:error':
        if (event.adapter) {
          settle(event.adapter, {
            status: 'error',
            errorMessage: event.message,
          });
        }
        break;
      case 'index:end':
        outcome = { status: 'complete' };
        for (const [name, state] of byName) {
          if (state.status === 'running') settle(name, { status: 'fresh' });
        }
        break;
      case 'index:error':
        outcome = { status: 'error', errorMessage: event.message };
        break;
    }
  }

  return {
    ...outcome,
    adapters: Array.from(byName.values()),
    totalAdapters,
  };
}

function useIndexProgressState(events: IndexProgressEvent[]): IndexState {
  return useMemo(() => aggregateEvents(events), [events]);
}

function useProgressOpenState({
  status,
  resetKey,
  controlledOpen,
  onOpenChange,
}: {
  status: ProgressOpenStatus;
  resetKey: string | number;
  controlledOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const key = `${resetKey}:${status}`;
  const [openOverride, setOpenOverride] = useState<OpenOverride | null>(null);

  const isOpen =
    controlledOpen ??
    (openOverride?.key === key ? openOverride.open : status === 'running');

  const handleOpenChange = (next: boolean) => {
    if (controlledOpen === undefined) {
      setOpenOverride({ key, open: next });
    }
    onOpenChange?.(next);
  };

  return { isOpen, handleOpenChange };
}

function shouldHideIndexProgress(
  events: IndexProgressEvent[],
  state: IndexState,
) {
  if (events.length === 0) return true;
  if (state.status !== 'complete' || state.adapters.length === 0) return false;
  return state.adapters.every((a) => a.status === 'cache-hit');
}

function getIndexRunKey(events: IndexProgressEvent[]) {
  return events.filter((event) => event.type === 'index:start').length;
}

function getAdapterRunKey(events: IndexProgressEvent[]) {
  return events.filter((event) =>
    ['adapter:start', 'adapter:cache-hit', 'adapter:cache-miss'].includes(
      event.type,
    ),
  ).length;
}

function getBreadcrumbSegments(state: IndexState, t: GenaiTranslate): string[] {
  const totalCount = state.totalAdapters ?? state.adapters.length;
  const isMultiAdapter = totalCount > 1;

  if (state.status === 'error') {
    const failed = state.adapters.find(
      (a): a is FailedAdapterState => a.status === 'error',
    );
    if (failed) {
      const segments = [t('indexing.failed')];
      if (isMultiAdapter) segments.push(failed.name);
      segments.push(failed.errorMessage);
      return segments;
    }
    return getGlobalErrorSegments(state.errorMessage, t);
  }

  if (state.status === 'running') {
    const segments: string[] = [t('indexing.running')];
    const active = state.adapters.find((a) => a.status === 'running');
    if (active) {
      if (isMultiAdapter) segments.push(active.name);
      if (active.phase) segments.push(active.phase);
      if (active.current != null && active.total != null) {
        segments.push(`${active.current}/${active.total}`);
      }
      if (active.table) segments.push(active.table);
    }
    return segments;
  }

  if (state.adapters.length === 0 || !isMultiAdapter) {
    return [t('indexing.done')];
  }
  return [
    t('indexing.done'),
    t('indexing.adapters', { count: state.adapters.length }),
  ];
}

function getAdapterBreadcrumbSegments(
  adapter: AdapterState,
  t: GenaiTranslate,
): string[] {
  if (adapter.status === 'error') {
    return [t('indexing.failed'), adapter.name, adapter.errorMessage];
  }

  if (adapter.status === 'running') {
    const segments = [t('indexing.running'), adapter.name];
    if (adapter.phase) segments.push(adapter.phase);
    if (adapter.current != null && adapter.total != null) {
      segments.push(`${adapter.current}/${adapter.total}`);
    }
    if (adapter.table) segments.push(adapter.table);
    return segments;
  }

  if (adapter.status === 'cache-hit') {
    return [t('indexing.done'), adapter.name, t('indexing.cacheHit')];
  }

  if (adapter.status === 'fresh') {
    return [t('indexing.done'), adapter.name, t('indexing.refreshed')];
  }

  return [t('indexing.running'), adapter.name, t('indexing.queued')];
}

function getGlobalErrorSegments(
  errorMessage: string,
  t: GenaiTranslate,
): string[] {
  return [t('indexing.failed'), errorMessage];
}

type IndexProgressContextValue = {
  state: IndexState;
  events: IndexProgressEvent[];
};

const IndexProgressContext = createContext<IndexProgressContextValue | null>(
  null,
);

function useIndexProgress(component: string): IndexProgressContextValue {
  const ctx = use(IndexProgressContext);
  if (!ctx) {
    throw new Error(
      `<IndexProgress.${component}> must be used inside <IndexProgress.Root>`,
    );
  }
  return ctx;
}

type RootProps = {
  events: IndexProgressEvent[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
};

function Root({
  events,
  open: controlledOpen,
  onOpenChange,
  children,
  className,
}: RootProps) {
  const state = useIndexProgressState(events);
  const { isOpen, handleOpenChange } = useProgressOpenState({
    status: state.status,
    resetKey: getIndexRunKey(events),
    controlledOpen,
    onOpenChange,
  });

  if (shouldHideIndexProgress(events, state)) return null;

  return (
    <IndexProgressContext value={{ state, events }}>
      <Collapsible
        open={isOpen}
        onOpenChange={handleOpenChange}
        data-slot="index-progress-root"
        data-status={state.status}
        className={cn('w-full', className)}
      >
        {children}
      </Collapsible>
    </IndexProgressContext>
  );
}

function Trigger({ className }: { className?: string }) {
  const { state } = useIndexProgress('Trigger');
  const t = useGenaiMessages();

  return (
    <CollapsibleTrigger
      render={
        <button
          type="button"
          data-slot="index-progress-trigger"
          className={getProgressTriggerClassName(className)}
        />
      }
    >
      <ProgressBreadcrumb
        segments={getBreadcrumbSegments(state, t)}
        isRunning={state.status === 'running'}
      />
      <DisclosureChevron />
    </CollapsibleTrigger>
  );
}

function getProgressTriggerClassName(className?: string) {
  return compactDisclosureTriggerClass(cn('items-baseline px-1', className));
}

function ProgressBreadcrumb({
  segments,
  isRunning,
}: {
  segments: string[];
  isRunning: boolean;
}) {
  const lastIdx = segments.length - 1;

  return (
    <TextShimmer
      as="span"
      enabled={isRunning}
      className="text-muted-foreground min-w-0 flex-1 truncate text-xs"
    >
      {segments.map((segment, idx) => (
        <ProgressBreadcrumbSegment
          key={idx}
          segment={segment}
          index={idx}
          isLast={idx === lastIdx}
        />
      ))}
    </TextShimmer>
  );
}

function ProgressBreadcrumbSegment({
  segment,
  index,
  isLast,
}: {
  segment: string;
  index: number;
  isLast: boolean;
}) {
  return (
    <Fragment>
      {index > 0 && (
        <span aria-hidden className="text-muted-foreground/40 mx-1.5">
          ›
        </span>
      )}
      <span
        className={cn(
          isLast ? 'text-foreground/90' : 'text-muted-foreground/70',
          index === 0 && 'lowercase',
        )}
      >
        {segment}
      </span>
    </Fragment>
  );
}

function DisclosureChevron() {
  return (
    <CompactDisclosureChevron className="text-muted-foreground/60 size-3" />
  );
}

function Content({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <CollapsibleContent
      data-slot="index-progress-content"
      className={className}
    >
      {children}
    </CollapsibleContent>
  );
}

function EventRow({ event }: { event: IndexProgressEvent }) {
  return (
    <li className="text-muted-foreground/90 flex items-baseline gap-3">
      <span className="text-muted-foreground/50 w-40 shrink-0 truncate">
        {event.type}
      </span>
      <span className="text-foreground/80 min-w-0 flex-1 truncate">
        {event.message}
      </span>
      {typeof event.current === 'number' && typeof event.total === 'number' && (
        <span className="text-muted-foreground/60 tabular-nums">
          {event.current}/{event.total}
        </span>
      )}
    </li>
  );
}

function useGroupedProgressEvents(
  events: IndexProgressEvent[],
): GroupedProgressEvents {
  return useMemo(() => {
    const map = new Map<string, IndexProgressEvent[]>();
    const global: IndexProgressEvent[] = [];

    for (const event of events) {
      if (event.adapter) {
        const arr = map.get(event.adapter) ?? [];
        arr.push(event);
        map.set(event.adapter, arr);
      } else {
        global.push(event);
      }
    }

    return { byAdapter: map, globalEvents: global };
  }, [events]);
}

function EventLog({ className }: { className?: string }) {
  const { events } = useIndexProgress('EventLog');
  const groupedEvents = useGroupedProgressEvents(events);
  const containerClass = cn(
    'mt-2 ml-4 max-h-64 overflow-y-auto font-mono text-[11px]',
    className,
  );

  if (groupedEvents.byAdapter.size <= 1) {
    return <SingleEventLog events={events} className={containerClass} />;
  }

  return (
    <GroupedEventLog groupedEvents={groupedEvents} className={containerClass} />
  );
}

function StickyScroll({
  className,
  contentClassName,
  children,
}: {
  className?: string;
  contentClassName?: string;
  children: ReactNode;
}) {
  const { scrollRef, contentRef } = useStickToBottom(STICK_TO_BOTTOM_OPTS);
  return (
    <div ref={scrollRef} className={className}>
      <div
        ref={contentRef}
        data-slot="index-progress-event-log"
        className={contentClassName}
      >
        {children}
      </div>
    </div>
  );
}

function SingleEventLog({
  events,
  className,
}: {
  events: IndexProgressEvent[];
  className: string;
}) {
  return (
    <StickyScroll className={className}>
      <ul className="space-y-0.5">
        {events.map((event, index) => (
          <EventRow key={`${event.type}-${index}`} event={event} />
        ))}
      </ul>
    </StickyScroll>
  );
}

function GroupedEventLog({
  groupedEvents,
  className,
}: {
  groupedEvents: GroupedProgressEvents;
  className: string;
}) {
  return (
    <StickyScroll className={className} contentClassName="space-y-2">
      {groupedEvents.globalEvents.length > 0 && (
        <ul className="space-y-0.5">
          {groupedEvents.globalEvents.map((event, index) => (
            <EventRow key={`${event.type}-${index}`} event={event} />
          ))}
        </ul>
      )}
      {Array.from(groupedEvents.byAdapter.entries()).map(([name, events]) => (
        <AdapterEventGroup key={name} name={name} events={events} />
      ))}
    </StickyScroll>
  );
}

function AdapterEventGroup({
  name,
  events,
}: {
  name: string;
  events: IndexProgressEvent[];
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-foreground/90">{name}</div>
      <ul className="space-y-0.5">
        {events.map((event, index) => (
          <EventRow key={`${event.type}-${index}`} event={event} />
        ))}
      </ul>
    </div>
  );
}

type PerAdapterProps = {
  events: IndexProgressEvent[];
  className?: string;
  showCacheHits?: boolean;
};

function PerAdapter({
  events,
  className,
  showCacheHits = false,
}: PerAdapterProps) {
  const state = useIndexProgressState(events);
  const groupedEvents = useGroupedProgressEvents(events);
  const globalErrorEvents = groupedEvents.globalEvents.filter(
    (event) => event.type === 'index:error',
  );
  const latestGlobalError = globalErrorEvents.at(-1);

  if (events.length === 0) return null;
  if (!showCacheHits && shouldHideIndexProgress(events, state)) return null;

  if (state.adapters.length === 0) {
    return (
      <Root events={events} className={className}>
        <Trigger />
        <Content>
          <EventLog />
        </Content>
      </Root>
    );
  }

  return (
    <div
      data-slot="index-progress-per-adapter"
      data-status={state.status}
      className={cn('w-full space-y-1', className)}
    >
      {state.adapters.map((adapter) => (
        <AdapterProgressItem
          key={adapter.name}
          adapter={adapter}
          events={groupedEvents.byAdapter.get(adapter.name) ?? []}
        />
      ))}
      {latestGlobalError && (
        <GlobalErrorProgressItem
          state={state}
          errorMessage={latestGlobalError.message}
          events={globalErrorEvents}
        />
      )}
    </div>
  );
}

function AdapterProgressItem({
  adapter,
  events,
}: {
  adapter: AdapterState;
  events: IndexProgressEvent[];
}) {
  const t = useGenaiMessages();
  const { isOpen, handleOpenChange } = useProgressOpenState({
    status: adapter.status,
    resetKey: getAdapterRunKey(events),
  });

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={handleOpenChange}
      data-slot="index-progress-adapter"
      data-status={adapter.status}
      className="w-full"
    >
      <CollapsibleTrigger
        render={
          <button
            type="button"
            data-slot="index-progress-adapter-trigger"
            className={getProgressTriggerClassName()}
          />
        }
      >
        <ProgressBreadcrumb
          segments={getAdapterBreadcrumbSegments(adapter, t)}
          isRunning={adapter.status === 'running'}
        />
        <DisclosureChevron />
      </CollapsibleTrigger>
      <CollapsibleContent data-slot="index-progress-adapter-content">
        <AdapterProgressEventLog events={events} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function AdapterProgressEventLog({ events }: { events: IndexProgressEvent[] }) {
  if (events.length === 0) return null;

  return (
    <SingleEventLog
      events={events}
      className="mt-2 ml-4 max-h-64 overflow-y-auto font-mono text-[11px]"
    />
  );
}

function GlobalErrorProgressItem({
  state,
  errorMessage,
  events,
}: {
  state: IndexState;
  errorMessage: string;
  events: IndexProgressEvent[];
}) {
  const t = useGenaiMessages();
  const { isOpen, handleOpenChange } = useProgressOpenState({
    status: state.status,
    resetKey: events.length,
  });

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={handleOpenChange}
      data-slot="index-progress-global-error"
      data-status={state.status}
      className="w-full"
    >
      <CollapsibleTrigger
        render={
          <button
            type="button"
            data-slot="index-progress-global-error-trigger"
            className={getProgressTriggerClassName()}
          />
        }
      >
        <ProgressBreadcrumb
          segments={getGlobalErrorSegments(errorMessage, t)}
          isRunning={state.status === 'running'}
        />
        <DisclosureChevron />
      </CollapsibleTrigger>
      <CollapsibleContent data-slot="index-progress-global-error-content">
        <AdapterProgressEventLog events={events} />
      </CollapsibleContent>
    </Collapsible>
  );
}

export const IndexProgress = {
  Root,
  Trigger,
  Content,
  EventLog,
  PerAdapter,
};
