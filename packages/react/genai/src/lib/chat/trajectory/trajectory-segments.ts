import type { UIMessage } from 'ai';
import { isStaticToolUIPart } from 'ai';

import { urlCitationsOf } from '../citations.ts';

export type TimelineNodeKind = 'tool' | 'dynamic-tool' | 'reasoning';

export type MessageTrajectorySegment =
  | { kind: 'text'; parts: { part: UIMessage['parts'][number]; idx: number }[] }
  | { kind: 'file'; part: UIMessage['parts'][number]; idx: number }
  | { kind: 'tool'; part: UIMessage['parts'][number]; idx: number }
  | { kind: 'dynamic-tool'; part: UIMessage['parts'][number]; idx: number }
  | { kind: 'reasoning'; part: UIMessage['parts'][number]; idx: number }
  | {
      kind: 'source';
      parts: { part: UIMessage['parts'][number]; idx: number }[];
    };

export function classifyPart(
  part: UIMessage['parts'][number],
): TimelineNodeKind | null {
  if (isStaticToolUIPart(part)) return 'tool';
  if (part.type === 'dynamic-tool') return 'dynamic-tool';
  if (part.type === 'reasoning' && 'text' in part && part.text) {
    return 'reasoning';
  }
  return null;
}

export function buildMessageTrajectorySegments(
  parts: UIMessage['parts'],
): MessageTrajectorySegment[] {
  const segments: MessageTrajectorySegment[] = [];
  // A source a text citation draws inline is not drawn again on its own.
  const citedInline = new Set(
    parts.flatMap((part) =>
      part.type === 'text'
        ? urlCitationsOf(part.citations).map(({ source }) => source.url)
        : [],
    ),
  );

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const nodeKind = classifyPart(part);

    if (nodeKind) {
      segments.push({ kind: nodeKind, part, idx: i });
    } else if (part.type === 'text') {
      const last = segments[segments.length - 1];
      if (last && last.kind === 'text') {
        last.parts.push({ part, idx: i });
      } else {
        segments.push({ kind: 'text', parts: [{ part, idx: i }] });
      }
    } else if (part.type === 'file') {
      segments.push({ kind: 'file', part, idx: i });
    } else if (part.type === 'source-url' && !citedInline.has(part.url)) {
      const last = segments[segments.length - 1];
      if (last && last.kind === 'source') {
        last.parts.push({ part, idx: i });
      } else {
        segments.push({ kind: 'source', parts: [{ part, idx: i }] });
      }
    }
  }

  return segments;
}

export function getSegmentKey(
  segment: MessageTrajectorySegment,
  fallback: number,
): number {
  if (segment.kind === 'text' || segment.kind === 'source') {
    return segment.parts[0]?.idx ?? fallback;
  }
  return segment.idx;
}
