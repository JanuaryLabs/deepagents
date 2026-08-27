import type { UIMessage } from 'ai';
import { isStaticToolUIPart } from 'ai';

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

export function isVisibleTrajectoryNode(
  segment: MessageTrajectorySegment,
  debugMode: boolean | undefined,
): boolean {
  if (segment.kind === 'text' || segment.kind === 'file') return false;
  if (segment.kind === 'source') return false;
  if (segment.kind === 'reasoning') return true;
  if (segment.kind === 'dynamic-tool') {
    return !!debugMode;
  }
  return true;
}

export function shouldShowConnector(
  segments: MessageTrajectorySegment[],
  segmentIndex: number,
  debugMode: boolean | undefined,
): boolean {
  const next = segments[segmentIndex + 1];
  return !!next && isVisibleTrajectoryNode(next, debugMode);
}

export function buildMessageTrajectorySegments(
  parts: UIMessage['parts'],
): MessageTrajectorySegment[] {
  const segments: MessageTrajectorySegment[] = [];

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
    } else if (part.type === 'source-url') {
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
