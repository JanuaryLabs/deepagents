import type { ToolUIPart, UIMessage } from 'ai';
import { isStaticToolUIPart } from 'ai';
import { type ReactNode, createContext, use, useMemo } from 'react';
import { Fragment } from 'react/jsx-runtime';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@deepagents/react-shadcn';

import { CitationPill } from '../../../components/CitationPill.tsx';
import { DynamicToolDebug } from '../../../components/tool-debug.tsx';
import { useIsAssistantSnapshotRender } from '../../../copy/assistant-snapshot.tsx';
import { Response } from '../../../elements/Response.tsx';
import {
  isActiveClientInputTool,
  resolveToolEntry,
} from '../../../tools/helpers.ts';
import type { ToolLabel } from '../../../tools/registry.ts';
import { useAgent, useAgentMessages } from '../../agent-context.tsx';
import {
  citationIndexOf,
  extractSourcesFromMessages,
} from '../../citations.ts';
import {
  AssistantTextPart,
  FilePart,
  SLIDE_UP_ANIMATED,
  ToolPartContent,
  useShowDebug,
} from '../../message-parts.tsx';
import { isToolAborted } from '../../tool-abort.ts';
import type { MessagesContextValue } from '../messages-context.ts';
import { useMessagesStatus } from '../messages-context.ts';
import { ToolLabelBlock } from '../tool-label.tsx';
import type { MessageTrajectorySegment } from '../trajectory-segments.ts';

export function isCommentaryTextPart(part: UIMessage['parts'][number]) {
  return (
    part.type === 'text' &&
    part.providerMetadata?.openai?.phase === 'commentary'
  );
}

function SegmentText({
  segment,
  elements,
  className,
}: {
  segment: Extract<MessageTrajectorySegment, { kind: 'text' }>;
  elements?: MessagesContextValue['elements'];
  className?: string;
}) {
  return (
    <Fragment>
      {segment.parts.map(({ part, idx }) => {
        if (part.type !== 'text') return null;
        return (
          <AssistantTextPart
            key={`${idx}-text`}
            text={part.text}
            elements={elements}
            className={className}
          />
        );
      })}
    </Fragment>
  );
}

function SegmentFile({
  segment,
}: {
  segment: Extract<MessageTrajectorySegment, { kind: 'file' }>;
}) {
  const { part } = segment;
  if (part.type !== 'file') return null;
  return <FilePart filename={part.filename} mediaType={part.mediaType} />;
}

function SegmentSource({
  segment,
}: {
  segment: Extract<MessageTrajectorySegment, { kind: 'source' }>;
}) {
  const { messages } = useAgentMessages();
  const sources = useMemo(
    () => extractSourcesFromMessages(messages),
    [messages],
  );

  return (
    <span>
      {segment.parts.map(({ part, idx }) => {
        if (part.type !== 'source-url') return null;
        const index = citationIndexOf(sources, part.url);
        if (index === null) return null;
        return (
          <CitationPill
            key={`source-${idx}`}
            source={{ url: part.url, title: part.title }}
            index={index}
          />
        );
      })}
    </span>
  );
}

function SegmentReasoning({
  segment,
}: {
  segment: Extract<MessageTrajectorySegment, { kind: 'reasoning' }>;
}) {
  const status = useMessagesStatus();
  const isSnapshotRender = useIsAssistantSnapshotRender();
  if (isSnapshotRender) return null;
  const { part } = segment;
  if (part.type !== 'reasoning') return null;

  return (
    <div className="text-muted-foreground text-xs">
      <Response
        animated={SLIDE_UP_ANIMATED}
        isAnimating={status === 'streaming'}
      >
        {part.text}
      </Response>
    </div>
  );
}

function SegmentDynamicTool({
  segment,
}: {
  segment: Extract<MessageTrajectorySegment, { kind: 'dynamic-tool' }>;
}) {
  const showDebug = useShowDebug();
  if (!showDebug) return null;
  const { part } = segment;
  if (part.type !== 'dynamic-tool') return null;
  return <DynamicToolDebug part={part} />;
}

type ToolSegmentContextValue = {
  part: ToolUIPart;
  label: ToolLabel | undefined;
  aborted: boolean;
  activeClientInput: boolean;
  defaultOpen: boolean;
};

const ToolSegmentContext = createContext<ToolSegmentContextValue | null>(null);

/**
 * Marker-relevant subset for arrangement wrappers (Timeline.Item) that sit
 * inside Segment.Tool and need label/state without the strict-context throw.
 */
export const ToolSegmentMarkerContext = createContext<{
  label: ToolLabel | undefined;
  state: ToolUIPart['state'];
  aborted: boolean;
} | null>(null);

export function useToolSegment() {
  const context = use(ToolSegmentContext);
  if (!context) {
    throw new Error('Segment.Tool* parts must be rendered within Segment.Tool');
  }
  return context;
}

function SegmentTool({
  segment,
  children,
}: {
  segment: Extract<MessageTrajectorySegment, { kind: 'tool' }>;
  children?: ReactNode;
}) {
  const agent = useAgent();
  const status = useMessagesStatus();
  const { toolEntry } = resolveToolEntry(segment.part, agent.registry);
  const { part: toolPart } = segment;
  if (!isStaticToolUIPart(toolPart)) return null;
  const activeClientInput = isActiveClientInputTool(
    toolEntry,
    toolPart.state,
  );
  const aborted = !activeClientInput && isToolAborted(toolPart, status);
  const baseLabel = toolEntry?.label?.(toolPart);
  const label = aborted
    ? {
        ...(baseLabel ?? { name: toolPart.type.replace('tool-', '') }),
        isError: true,
        detail: 'Cancelled by user',
      }
    : baseLabel;
  const defaultOpen =
    toolEntry?.static === false &&
    !!toolEntry?.requiresUserInput &&
    !activeClientInput;

  return (
    <ToolSegmentContext
      value={{ part: toolPart, label, aborted, activeClientInput, defaultOpen }}
    >
      <ToolSegmentMarkerContext
        value={{ label, state: toolPart.state, aborted }}
      >
        {children ?? <SegmentToolDisclosure />}
      </ToolSegmentMarkerContext>
    </ToolSegmentContext>
  );
}

function SegmentToolContent() {
  const { part, activeClientInput } = useToolSegment();
  if (activeClientInput) return null;
  return <ToolPartContent part={part} />;
}

function SegmentToolDisclosure({ children }: { children?: ReactNode }) {
  const { part, label, defaultOpen } = useToolSegment();
  if (!label) {
    return (
      <div className="min-w-0 flex-1">
        <SegmentToolContent />
      </div>
    );
  }

  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="flex min-w-0 flex-1 flex-col"
    >
      <CollapsibleTrigger className="cursor-pointer">
        <ToolLabelBlock label={label} state={part.state} part={part}>
          {children}
        </ToolLabelBlock>
      </CollapsibleTrigger>
      <CollapsibleContent className="mb-2">
        <SegmentToolContent />
      </CollapsibleContent>
    </Collapsible>
  );
}

export const Segment = {
  Text: SegmentText,
  File: SegmentFile,
  Source: SegmentSource,
  Reasoning: SegmentReasoning,
  DynamicTool: SegmentDynamicTool,
  Tool: SegmentTool,
  ToolDisclosure: SegmentToolDisclosure,
  ToolContent: SegmentToolContent,
};
