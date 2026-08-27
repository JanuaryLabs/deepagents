import { Lightbulb } from 'lucide-react';
import { memo, useMemo } from 'react';

import { useIsAssistantSnapshotRender } from '../../../copy/assistant-snapshot.tsx';
import { useAgent } from '../../agent-context.tsx';
import { useShowDebug } from '../../message-parts.tsx';
import { useMessageItem, useMessagesContext } from '../messages-context.ts';
import { Segment } from '../segments/index.tsx';
import {
  buildMessageTrajectorySegments,
  getSegmentKey,
  shouldShowConnector,
} from '../trajectory-segments.ts';
import {
  CopyAssistantMessageAction,
  CopyAssistantMessageJsonAction,
  MessagesActions,
  RegenerateAction,
} from './message-actions.tsx';
import { MessagesError } from './messages-error.tsx';
import { MessagesItem, MessagesList, MessagesRoot } from './messages-shell.tsx';
import { Timeline } from './timeline.tsx';
import { TrajectoryThinking } from './trajectory-thinking.tsx';
import { MessagesUserBubble } from './user-message.tsx';

const TimelinedAssistantContent = memo(function TimelinedAssistantContent({
  className,
}: {
  className?: string;
}) {
  const { message } = useMessageItem();
  const { components } = useMessagesContext();
  const { debugMode } = useAgent();
  const showDebug = useShowDebug();
  const isSnapshotRender = useIsAssistantSnapshotRender();
  const segments = useMemo(
    () => buildMessageTrajectorySegments(message.parts),
    [message.parts],
  );

  return (
    <div className={className}>
      {segments.map((segment, segmentIndex) => {
        const key = `${message.id}-${getSegmentKey(segment, segmentIndex)}-${segment.kind}`;

        if (segment.kind === 'text') {
          return (
            <Segment.Text
              key={key}
              segment={segment}
              components={components}
              className="my-4"
            />
          );
        }
        if (segment.kind === 'file') {
          return <Segment.File key={key} segment={segment} />;
        }
        if (segment.kind === 'source') {
          return <Segment.Source key={key} segment={segment} />;
        }
        if (segment.kind === 'dynamic-tool') {
          if (!showDebug) return null;
          // Connector quirk preserved: dynamic-tool visibility passes `true`.
          const isLast = !shouldShowConnector(segments, segmentIndex, true);
          return (
            <Timeline.Item key={key} isLast={isLast}>
              <Segment.DynamicTool segment={segment} />
            </Timeline.Item>
          );
        }
        if (segment.kind === 'reasoning') {
          if (isSnapshotRender) return null;
          if (segment.part.type !== 'reasoning') return null;
          const isLast = !shouldShowConnector(
            segments,
            segmentIndex,
            debugMode,
          );
          const label = {
            name: 'Reasoning',
            icon: Lightbulb,
            args: { text: [...segment.part.text].slice(0, 60).join('') },
          };
          return (
            <Timeline.Item key={key} isLast={isLast} label={label}>
              <Timeline.Disclosure label={label}>
                <Segment.Reasoning segment={segment} />
              </Timeline.Disclosure>
            </Timeline.Item>
          );
        }
        if (segment.kind === 'tool') {
          const isLast = !shouldShowConnector(
            segments,
            segmentIndex,
            debugMode,
          );
          return (
            <Segment.Tool key={key} segment={segment}>
              <Timeline.Item isLast={isLast}>
                <Segment.ToolDisclosure />
              </Timeline.Item>
            </Segment.Tool>
          );
        }
        return null;
      })}
    </div>
  );
});

export const TimelinedMessages = {
  Root: MessagesRoot,
  List: MessagesList,
  Item: MessagesItem,
  UserBubble: MessagesUserBubble,
  AssistantContent: TimelinedAssistantContent,
  Actions: MessagesActions,
  CopyAction: CopyAssistantMessageAction,
  RegenerateAction: RegenerateAction,
  CopyDebugJsonAction: CopyAssistantMessageJsonAction,
  Thinking: TrajectoryThinking,
  Error: MessagesError,
};
