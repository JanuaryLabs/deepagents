import type { UIMessage } from 'ai';
import { isToolUIPart } from 'ai';
import { memo, useMemo } from 'react';

import { cn } from '@deepagents/react-shadcn';

import { Segment } from './segments/index.tsx';
import {
  buildMessageTrajectorySegments,
  getSegmentKey,
} from './trajectory-segments.ts';
import type { MessageTrajectorySegment } from './trajectory-segments.ts';

function getSegmentCacheKey(segment: MessageTrajectorySegment, index: number) {
  const prefix = `${getSegmentKey(segment, index)}:${segment.kind}`;

  if (segment.kind === 'text') {
    const text = segment.parts
      .map(({ part }) => (part.type === 'text' ? part.text : ''))
      .join('\u001f');
    return `${prefix}:${text}`;
  }

  if (segment.kind === 'reasoning' && segment.part.type === 'reasoning') {
    return `${prefix}:${segment.part.text}`;
  }

  if (
    (segment.kind === 'tool' || segment.kind === 'dynamic-tool') &&
    isToolUIPart(segment.part)
  ) {
    const error =
      segment.part.state === 'output-error' ? segment.part.errorText : '';
    const preliminary =
      'preliminary' in segment.part && segment.part.preliminary === true;
    return `${prefix}:${segment.part.toolCallId}:${segment.part.state}:${preliminary}:${error}`;
  }

  if (segment.kind === 'file' && segment.part.type === 'file') {
    return `${prefix}:${segment.part.url}:${segment.part.mediaType}:${segment.part.filename ?? ''}`;
  }

  return prefix;
}

function isCompletedSegment(
  segment: MessageTrajectorySegment,
  index: number,
  segmentCount: number,
) {
  if (segment.kind === 'file' || segment.kind === 'source') return true;

  if (segment.kind === 'tool' || segment.kind === 'dynamic-tool') {
    if (!isToolUIPart(segment.part)) return false;
    if (segment.part.state === 'output-error') return true;
    return (
      segment.part.state === 'output-available' &&
      segment.part.preliminary !== true
    );
  }

  // Text and reasoning parts can still grow while they are the tail. Once a
  // later segment exists, the AI SDK stream has closed them and they are safe
  // to preserve across the cumulative snapshots sent by subagents.
  return index < segmentCount - 1;
}

type NestedTrajectorySegmentProps = {
  segment: MessageTrajectorySegment;
  cacheKey: string;
  complete: boolean;
};

const NestedTrajectorySegment = memo(function NestedTrajectorySegment({
  segment,
}: NestedTrajectorySegmentProps) {
  if (segment.kind === 'tool') {
    return <Segment.Tool segment={segment} />;
  }
  if (segment.kind === 'reasoning') {
    return <Segment.Reasoning segment={segment} />;
  }
  if (segment.kind === 'text') {
    return <Segment.Text segment={segment} className="text-xs" />;
  }
  if (segment.kind === 'file') {
    return <Segment.File segment={segment} />;
  }
  return null;
}, areNestedTrajectorySegmentPropsEqual);

function areNestedTrajectorySegmentPropsEqual(
  previous: NestedTrajectorySegmentProps,
  next: NestedTrajectorySegmentProps,
) {
  return (
    previous.complete && next.complete && previous.cacheKey === next.cacheKey
  );
}

/**
 * Replays a trajectory that is not the host message's own — currently a
 * subagent's run, captured into its tool output. It reuses the same Segment
 * primitives as the top-level trajectory, so the subagent's tool calls resolve
 * against the host registry and render with their real components (a `db_query`
 * step shows its table, not a stringified blob).
 *
 * Segments read the surrounding agent/messages contexts, so this only renders
 * inside a message.
 */
export function NestedTrajectory({
  parts,
  className,
}: {
  parts: UIMessage['parts'];
  className?: string;
}) {
  const segments = useMemo(
    () => buildMessageTrajectorySegments(parts),
    [parts],
  );

  if (segments.length === 0) return null;

  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      {segments.map((segment, index) => {
        const key = `${getSegmentKey(segment, index)}-${segment.kind}`;
        return (
          <NestedTrajectorySegment
            key={key}
            segment={segment}
            cacheKey={getSegmentCacheKey(segment, index)}
            complete={isCompletedSegment(segment, index, segments.length)}
          />
        );
      })}
    </div>
  );
}
