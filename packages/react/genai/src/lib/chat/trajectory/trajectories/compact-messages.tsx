import {
  type ChatStatus,
  type ToolUIPart,
  type UIMessage,
  isStaticToolUIPart,
  isToolUIPart,
} from 'ai';
import {
  type ReactNode,
  createContext,
  memo,
  use,
  useMemo,
  useState,
} from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  cn,
} from '@deepagents/react-shadcn';

import { TextShimmer } from '../../../components/text-shimmer.tsx';
import { isSubagentPart, resolveToolEntry } from '../../../tools/helpers.ts';
import type { ComponentRegistry, ToolLabel } from '../../../tools/registry.ts';
import { useAgent } from '../../agent-context.tsx';
import { isToolStateAborted } from '../../tool-abort.ts';
import {
  CompactDisclosureChevron,
  compactDisclosureTriggerClass,
} from '../compact-disclosure.tsx';
import {
  useMessageItem,
  useMessagesContext,
  useMessagesStatus,
} from '../messages-context.ts';
import { Segment, isCommentaryTextPart } from '../segments/index.tsx';
import {
  type MessageTrajectorySegment,
  buildMessageTrajectorySegments,
  getSegmentKey,
} from '../trajectory-segments.ts';
import {
  CopyAssistantMessageAction,
  CopyAssistantMessageJsonAction,
  MessagesActions,
  RegenerateAction,
} from './message-actions.tsx';
import { MessagesError } from './messages-error.tsx';
import { MessagesItem, MessagesList, MessagesRoot } from './messages-shell.tsx';
import { TrajectoryThinking } from './trajectory-thinking.tsx';
import { MessagesUserBubble } from './user-message.tsx';

type CompactNodeGroupItem = {
  segment: MessageTrajectorySegment;
};

type CompactRenderItem =
  | {
      kind: 'segment';
      segment: MessageTrajectorySegment;
      segmentIndex: number;
    }
  | {
      kind: 'group';
      items: CompactNodeGroupItem[];
      hasLaterText: boolean;
      firstIndex: number;
    };

/**
 * Subagent calls are deliberately excluded: everything a compact node touches
 * gets folded into the "Ran N tools" group, which collapses as soon as the
 * assistant produces text. A delegation to another agent stays in the message
 * flow as its own chip instead of disappearing into that group.
 */
function isCompactNodeSegment(segment: MessageTrajectorySegment) {
  if (segment.kind === 'tool') return !isSubagentPart(segment.part);
  return segment.kind === 'dynamic-tool' || segment.kind === 'reasoning';
}

function isVisibleCompactNode(
  segment: MessageTrajectorySegment,
  debugMode: boolean | undefined,
) {
  if (segment.kind === 'tool') return true;
  if (segment.kind === 'reasoning' || segment.kind === 'dynamic-tool') {
    return !!debugMode;
  }
  return false;
}

function hasVisibleTranscriptText(segment: MessageTrajectorySegment) {
  return (
    segment.kind === 'text' &&
    segment.parts.some(
      ({ part }) => part.type === 'text' && !isCommentaryTextPart(part),
    )
  );
}

function buildCompactRenderItems(
  segments: MessageTrajectorySegment[],
  debugMode: boolean | undefined,
): CompactRenderItem[] {
  const items: CompactRenderItem[] = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    if (!isCompactNodeSegment(segment)) {
      items.push({ kind: 'segment', segment, segmentIndex: i });
      continue;
    }

    const group: CompactNodeGroupItem[] = [];
    const firstIndex = i;

    while (i < segments.length && isCompactNodeSegment(segments[i])) {
      const nodeSegment = segments[i];
      if (isVisibleCompactNode(nodeSegment, debugMode)) {
        group.push({ segment: nodeSegment });
      }
      i++;
    }
    i--;

    if (group.length > 0) {
      items.push({
        kind: 'group',
        items: group,
        hasLaterText: segments
          .slice(i + 1)
          .some((next) => hasVisibleTranscriptText(next)),
        firstIndex,
      });
    }
  }

  return items;
}

function getToolPartState(segment: MessageTrajectorySegment) {
  if (segment.kind !== 'tool' && segment.kind !== 'dynamic-tool') {
    return undefined;
  }

  const { part } = segment;
  return isToolUIPart(part) ? part.state : undefined;
}

export type CompactSegmentLabel = {
  kind: 'tool' | 'dynamic-tool' | 'reasoning';
  name: string;
  args?: ToolLabel['args'];
  detail?: string;
  isError?: boolean;
};

export type CompactGroupStatus = 'running' | 'complete' | 'error' | 'aborted';

type CompactGroupTone = {
  title: string;
  detail: string;
  chevron: string;
};

function getCompactGroupTone({
  groupStatus,
  labelCount,
}: {
  groupStatus: CompactGroupStatus;
  labelCount: number;
}): CompactGroupTone {
  if (groupStatus === 'running') {
    return {
      title: 'text-info',
      detail: 'text-info/80',
      chevron: 'text-info',
    };
  }

  if (groupStatus === 'aborted') {
    return {
      title: 'text-destructive',
      detail: 'text-destructive/80',
      chevron: 'text-destructive',
    };
  }

  if (groupStatus === 'error') {
    const tone =
      labelCount === 1
        ? {
            title: 'text-destructive',
            detail: 'text-destructive/80',
            chevron: 'text-destructive',
          }
        : {
            title: 'text-warning',
            detail: 'text-warning/80',
            chevron: 'text-warning',
          };

    return tone;
  }

  return {
    title: 'text-muted-foreground',
    detail: 'text-muted-foreground',
    chevron: 'text-muted-foreground',
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shorten(value: string, maxLength = 80) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function stringifyArgValue(value: unknown): string | undefined {
  if (typeof value === 'string') return shorten(value, 48);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return `${value.length} items`;
  return undefined;
}

function getFallbackArgs(input: unknown): ToolLabel['args'] | undefined {
  if (!isPlainRecord(input)) return undefined;

  const preferredKeys = [
    'command',
    'query',
    'path',
    'file',
    'table',
    'metric',
    'dimension',
    'checks',
  ];
  const orderedEntries = [
    ...preferredKeys
      .filter((key) => key in input)
      .map((key) => [key, input[key]] as const),
    ...Object.entries(input).filter(([key]) => !preferredKeys.includes(key)),
  ];
  const args: Record<string, string | undefined> = {};

  for (const [key, value] of orderedEntries) {
    const stringValue = stringifyArgValue(value);
    if (!stringValue) continue;
    args[key] = stringValue;
    if (Object.keys(args).length >= 2) break;
  }

  return Object.keys(args).length > 0 ? args : undefined;
}

function getFallbackDetail(input: unknown): string | undefined {
  if (!isPlainRecord(input)) return undefined;

  for (const key of ['reasoning', 'thoughts', 'thought', 'hint', 'detail']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return shorten(value);
    }
  }

  return undefined;
}

function getReasoningPreview(segment: MessageTrajectorySegment) {
  if (segment.kind !== 'reasoning') return undefined;
  const { part } = segment;
  if (part.type !== 'reasoning') return undefined;
  return shorten(part.text, 96);
}

function getSegmentLabel(
  segment: MessageTrajectorySegment,
  registry: ComponentRegistry | undefined,
): CompactSegmentLabel {
  if (segment.kind === 'reasoning') {
    return {
      kind: 'reasoning',
      name: 'reasoning',
      detail: getReasoningPreview(segment),
    };
  }

  if (segment.kind === 'dynamic-tool' && segment.part.type === 'dynamic-tool') {
    const dynamicToolPart = segment.part;

    return {
      kind: 'dynamic-tool',
      name: dynamicToolPart.toolName || 'Tool',
      args: getFallbackArgs(dynamicToolPart.input),
      detail: getFallbackDetail(dynamicToolPart.input),
    };
  }

  if (segment.kind === 'tool' && isStaticToolUIPart(segment.part)) {
    const toolPart = segment.part;
    const { toolEntry, toolKey } = resolveToolEntry(toolPart, registry);
    const label = toolEntry?.label?.(toolPart);

    return {
      kind: 'tool',
      name: label?.name ?? toolKey,
      args: label?.args ?? getFallbackArgs(toolPart.input),
      detail: label?.detail ?? getFallbackDetail(toolPart.input),
      isError: label?.isError,
    };
  }

  return { kind: 'tool', name: 'Step' };
}

function formatArgs(args: ToolLabel['args'] | undefined) {
  if (!args) return undefined;
  const entries = Object.entries(args).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === 'string' && entry[1].trim().length > 0,
  );
  if (entries.length === 0) return undefined;

  return entries
    .slice(0, 2)
    .map(([key, value]) => `${key}: ${shorten(value, 36)}`)
    .join(', ');
}

function formatCallLabel(label: CompactSegmentLabel) {
  const args = formatArgs(label.args);
  return args ? `${label.name}(${args})` : label.name;
}

function isTerminalToolState(state: ToolUIPart['state'] | undefined) {
  return (
    state === 'output-available' ||
    state === 'output-error' ||
    state === 'output-denied'
  );
}

function isPendingToolState(state: ToolUIPart['state'] | undefined) {
  return !!state && !isTerminalToolState(state);
}

function isPendingToolAborted(
  state: ToolUIPart['state'] | undefined,
  status: ChatStatus,
) {
  return isToolStateAborted(state, status);
}

function getGroupStatus({
  items,
  labels,
  status,
  hasLaterText,
}: {
  items: CompactNodeGroupItem[];
  labels: CompactSegmentLabel[];
  status: ChatStatus;
  hasLaterText: boolean;
}): CompactGroupStatus {
  if (
    items.some(({ segment }) =>
      isPendingToolAborted(getToolPartState(segment), status),
    )
  ) {
    return 'aborted';
  }

  if (!hasLaterText && (status === 'streaming' || status === 'submitted')) {
    return 'running';
  }

  if (
    labels.some((label) => label.isError) ||
    items.some(({ segment }) => {
      const state = getToolPartState(segment);
      return state === 'output-error' || state === 'output-denied';
    })
  ) {
    return 'error';
  }

  if (
    items.some(({ segment }) => isPendingToolState(getToolPartState(segment)))
  ) {
    return 'running';
  }

  if (
    !hasLaterText &&
    labels.every((label) => label.kind === 'reasoning') &&
    (status === 'streaming' || status === 'submitted')
  ) {
    return 'running';
  }

  return 'complete';
}

function sentenceCase(value: string) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function getFallbackToolCount(labels: CompactSegmentLabel[]) {
  return labels.filter((label) => label.kind !== 'reasoning').length;
}

function formatFallbackToolSummary(
  labels: CompactSegmentLabel[],
  groupStatus: CompactGroupStatus,
) {
  const toolCount = getFallbackToolCount(labels);
  if (toolCount === 0) return undefined;
  const isRunning = groupStatus === 'running' || groupStatus === 'aborted';
  const verb = isRunning ? 'running' : 'ran';
  return `${verb} ${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`;
}

function getPlainCountSummary(
  labels: CompactSegmentLabel[],
  groupStatus: CompactGroupStatus,
) {
  const baseTitle = formatFallbackToolSummary(labels, groupStatus);
  if (!baseTitle) return undefined;

  const title =
    groupStatus === 'error'
      ? `${baseTitle} with issues`
      : groupStatus === 'aborted'
        ? `cancelled after ${baseTitle}`
        : baseTitle;

  return sentenceCase(title);
}

function getCompactSummaryText(
  labels: CompactSegmentLabel[],
  groupStatus: CompactGroupStatus,
  activeHint?: string,
) {
  const singleLabel = labels.length === 1 ? labels[0] : undefined;

  if (groupStatus === 'running') {
    if (activeHint) return activeHint;
    if (singleLabel?.kind === 'reasoning') {
      return `Reasoning${singleLabel.detail ? ` ${singleLabel.detail}` : ''}`;
    }
    if (labels.every((label) => label.kind === 'reasoning')) {
      return 'Reasoning';
    }
    return 'Working...';
  }

  if (singleLabel) {
    const callLabel = formatCallLabel(singleLabel);
    if (groupStatus === 'error') return `Failed ${callLabel}`;
    if (groupStatus === 'aborted') return `Cancelled ${callLabel}`;
    if (singleLabel.kind === 'reasoning') {
      return `Reasoned${singleLabel.detail ? ` ${singleLabel.detail}` : ''}`;
    }
    return `Called ${callLabel}`;
  }

  if (labels.every((label) => label.kind === 'reasoning')) {
    return 'Reasoned';
  }

  return getPlainCountSummary(labels, groupStatus) ?? 'Ran tools';
}

function getCompactSummaryDetail(
  labels: CompactSegmentLabel[],
  groupStatus: CompactGroupStatus,
) {
  if (groupStatus === 'running') return undefined;

  if (labels.length === 1) {
    const label = labels[0];
    if (label.kind === 'reasoning') return undefined;
    return label.detail;
  }

  const names = Array.from(
    new Set(
      [...labels]
        .sort((a, b) => {
          if (a.kind === 'reasoning' && b.kind !== 'reasoning') return 1;
          if (a.kind !== 'reasoning' && b.kind === 'reasoning') return -1;
          return 0;
        })
        .map((label) => label.name),
    ),
  );
  const detail = names.slice(0, 3).join(', ');
  return detail || undefined;
}

function getActiveGroupHint(items: CompactNodeGroupItem[]) {
  let reasoningHint: string | undefined;

  for (let i = items.length - 1; i >= 0; i--) {
    const segment = items[i].segment;

    if (
      segment.kind === 'dynamic-tool' &&
      segment.part.type === 'dynamic-tool'
    ) {
      const hint = getFallbackDetail(segment.part.input);
      if (hint) return hint;
    }

    if (segment.kind === 'tool' && isStaticToolUIPart(segment.part)) {
      const hint = getFallbackDetail(segment.part.input);
      if (hint) return hint;
    }

    if (segment.kind === 'reasoning') {
      reasoningHint ??= getReasoningPreview(segment);
    }
  }

  return reasoningHint;
}

function hasCurrentCompactNodeGroup(
  message: UIMessage | undefined,
  debugMode: boolean | undefined,
) {
  if (!message || message.role !== 'assistant') return false;

  const segments = buildMessageTrajectorySegments(message.parts);
  return buildCompactRenderItems(segments, debugMode).some(
    (item) => item.kind === 'group' && !item.hasLaterText,
  );
}

type CompactTrajectorySegmentItem = {
  kind: 'segment';
  key: string;
  segment: MessageTrajectorySegment;
  segmentIndex: number;
};

type CompactTrajectoryGroupItem = {
  kind: 'group';
  key: string;
  items: CompactNodeGroupItem[];
  hasLaterText: boolean;
  firstIndex: number;
};

export type CompactTrajectoryItem =
  CompactTrajectorySegmentItem | CompactTrajectoryGroupItem;

export function useTrajectoryItems(): CompactTrajectoryItem[] {
  const { message } = useMessageItem();
  const { debugMode } = useAgent();
  const segments = useMemo(
    () => buildMessageTrajectorySegments(message.parts),
    [message.parts],
  );
  return useMemo(
    () =>
      buildCompactRenderItems(segments, debugMode).map((item) =>
        item.kind === 'group'
          ? {
              ...item,
              key: `${message.id}-${item.firstIndex}-group-${
                item.hasLaterText ? 'past' : 'current'
              }`,
            }
          : {
              ...item,
              key: `${message.id}-${getSegmentKey(item.segment, item.segmentIndex)}-${item.segment.kind}`,
            },
      ),
    [segments, debugMode, message.id],
  );
}

type CompactGroupContextValue = {
  items: CompactNodeGroupItem[];
  labels: CompactSegmentLabel[];
  groupStatus: CompactGroupStatus;
  tone: CompactGroupTone;
  messageId: string;
};

const CompactGroupContext = createContext<CompactGroupContextValue | null>(
  null,
);

export function useCompactGroup() {
  const context = use(CompactGroupContext);
  if (!context) {
    throw new Error(
      'CompactTrajectory group parts must be rendered within CompactTrajectory.Group',
    );
  }
  return context;
}

function CompactTrajectoryGroup({
  group,
  children,
}: {
  group: { items: CompactNodeGroupItem[]; hasLaterText: boolean };
  children: ReactNode;
}) {
  const { registry } = useAgent();
  const { message } = useMessageItem();
  const status = useMessagesStatus();
  const [isOpen, setIsOpen] = useState(!group.hasLaterText);
  const labels = group.items.map(({ segment }) =>
    getSegmentLabel(segment, registry),
  );
  const groupStatus = getGroupStatus({
    items: group.items,
    labels,
    status,
    hasLaterText: group.hasLaterText,
  });
  const tone = getCompactGroupTone({ groupStatus, labelCount: labels.length });

  return (
    <CompactGroupContext
      value={{
        items: group.items,
        labels,
        groupStatus,
        tone,
        messageId: message.id,
      }}
    >
      <Collapsible
        open={isOpen}
        onOpenChange={setIsOpen}
        className="my-2 min-w-0"
      >
        {children}
      </Collapsible>
    </CompactGroupContext>
  );
}

function CompactTrajectoryGroupTrigger({ children }: { children: ReactNode }) {
  return (
    <CollapsibleTrigger
      render={
        <button
          type="button"
          className={compactDisclosureTriggerClass('items-start')}
        />
      }
    >
      <span className="min-w-0 flex-1 text-left text-sm">{children}</span>
    </CollapsibleTrigger>
  );
}

function useCompactGroupSummary() {
  const { items, labels, groupStatus, tone } = useCompactGroup();
  const title = getCompactSummaryText(
    labels,
    groupStatus,
    getActiveGroupHint(items),
  );
  const detail = getCompactSummaryDetail(labels, groupStatus);
  return { title, detail, tone, groupStatus };
}

function CompactTrajectoryGroupTitle({
  title: titleOverride,
  suffix,
  children,
}: {
  /** Host-computed replacement for the default plain-count summary. */
  title?: string;
  /** Host-computed trailer appended to whichever title renders (" · <suffix>"). */
  suffix?: string;
  children?: ReactNode;
}) {
  const { title: defaultTitle, tone, groupStatus } = useCompactGroupSummary();
  const baseTitle = titleOverride ?? defaultTitle;
  const title = suffix ? `${baseTitle} · ${suffix}` : baseTitle;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <TextShimmer
        as="span"
        enabled={groupStatus === 'running'}
        className={cn(
          'max-w-full min-w-0 truncate',
          groupStatus === 'running' ? 'text-info' : tone.title,
        )}
      >
        {title}
      </TextShimmer>
      {children}
    </span>
  );
}

function CompactTrajectoryGroupChevron() {
  const { tone } = useCompactGroup();
  return <CompactDisclosureChevron className={tone.chevron} />;
}

function CompactTrajectoryGroupDetail({
  detail: detailOverride,
}: {
  /** Host-computed replacement for the default detail line; null suppresses it. */
  detail?: string | null;
}) {
  const { title, detail: defaultDetail, tone } = useCompactGroupSummary();
  if (detailOverride === null) return null;
  const detail = detailOverride ?? defaultDetail;
  if (!detail || detail === title) return null;
  return (
    <span className={cn('block truncate text-xs', tone.detail)}>{detail}</span>
  );
}

function CompactTrajectoryGroupContent({ children }: { children?: ReactNode }) {
  const { items, messageId, groupStatus } = useCompactGroup();
  const isRunning = groupStatus === 'running';
  const { scrollRef, contentRef } = useStickToBottom({
    initial: 'instant',
    resize: 'instant',
  });

  return (
    <CollapsibleContent
      ref={isRunning ? scrollRef : undefined}
      className={cn('mt-2', isRunning && 'max-h-64 overflow-y-auto')}
    >
      <div ref={isRunning ? contentRef : undefined}>
        {children ??
          items.map(({ segment }, segmentIndex) => {
            const key = `${messageId}-${getSegmentKey(segment, segmentIndex)}-${segment.kind}`;
            if (segment.kind === 'tool') {
              return <Segment.Tool key={key} segment={segment} />;
            }
            if (segment.kind === 'reasoning') {
              return <Segment.Reasoning key={key} segment={segment} />;
            }
            if (segment.kind === 'dynamic-tool') {
              return <Segment.DynamicTool key={key} segment={segment} />;
            }
            return null;
          })}
      </div>
    </CollapsibleContent>
  );
}

function CompactTrajectorySegment({
  item,
  textClassName = 'my-4',
}: {
  item: CompactTrajectorySegmentItem;
  textClassName?: string;
}) {
  const { components } = useMessagesContext();
  const { segment } = item;

  if (segment.kind === 'text') {
    const visibleParts = segment.parts.filter(
      ({ part }) => !isCommentaryTextPart(part),
    );
    if (visibleParts.length === 0) return null;
    return (
      <Segment.Text
        segment={{ ...segment, parts: visibleParts }}
        components={components}
        className={textClassName}
      />
    );
  }
  if (segment.kind === 'file') return <Segment.File segment={segment} />;
  if (segment.kind === 'source') return <Segment.Source segment={segment} />;
  if (segment.kind === 'tool') return <Segment.Tool segment={segment} />;
  if (segment.kind === 'reasoning') {
    return <Segment.Reasoning segment={segment} />;
  }
  if (segment.kind === 'dynamic-tool') {
    return <Segment.DynamicTool segment={segment} />;
  }
  return null;
}

export const CompactTrajectory = {
  Group: CompactTrajectoryGroup,
  GroupTrigger: CompactTrajectoryGroupTrigger,
  GroupTitle: CompactTrajectoryGroupTitle,
  GroupChevron: CompactTrajectoryGroupChevron,
  GroupDetail: CompactTrajectoryGroupDetail,
  GroupContent: CompactTrajectoryGroupContent,
  Segment: CompactTrajectorySegment,
};

function CompactThinking() {
  const status = useMessagesStatus();
  const { messages } = useMessagesContext();
  const { debugMode } = useAgent();
  const latestMessage = messages[messages.length - 1];

  if (
    status !== 'ready' &&
    status !== 'error' &&
    hasCurrentCompactNodeGroup(latestMessage, debugMode)
  ) {
    return null;
  }

  return <TrajectoryThinking />;
}

const CompactAssistantContent = memo(function CompactAssistantContent({
  className,
}: {
  className?: string;
}) {
  const items = useTrajectoryItems();

  return (
    <div className={className}>
      {items.map((item) =>
        item.kind === 'group' ? (
          <CompactTrajectoryGroup key={item.key} group={item}>
            <CompactTrajectoryGroupTrigger>
              <CompactTrajectoryGroupTitle>
                <CompactTrajectoryGroupChevron />
              </CompactTrajectoryGroupTitle>
              <CompactTrajectoryGroupDetail />
            </CompactTrajectoryGroupTrigger>
            <CompactTrajectoryGroupContent />
          </CompactTrajectoryGroup>
        ) : (
          <CompactTrajectorySegment key={item.key} item={item} />
        ),
      )}
    </div>
  );
});

export const CompactMessages = {
  Root: MessagesRoot,
  List: MessagesList,
  Item: MessagesItem,
  UserBubble: MessagesUserBubble,
  AssistantContent: CompactAssistantContent,
  Actions: MessagesActions,
  CopyAction: CopyAssistantMessageAction,
  RegenerateAction: RegenerateAction,
  CopyDebugJsonAction: CopyAssistantMessageJsonAction,
  Thinking: CompactThinking,
  Error: MessagesError,
};
