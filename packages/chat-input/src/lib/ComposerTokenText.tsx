import type { ComposerTextElement } from './ComposerTypes.ts';

export function ComposerTokenText({
  text,
  elements,
}: {
  text: string;
  elements: ComposerTextElement[];
}) {
  const segments = tokenSegments(text, elements);
  return (
    <>
      {segments.map((segment) =>
        segment.element ? (
          <span
            key={`${segment.start}-${segment.end}-${segment.element.id}`}
            data-token={segment.element.kind}
          >
            {segment.text}
          </span>
        ) : (
          <span key={`${segment.start}-${segment.end}`}>{segment.text}</span>
        ),
      )}
    </>
  );
}

function tokenSegments(text: string, elements: ComposerTextElement[]) {
  const ordered = sortElements(elements).filter(
    (element) =>
      element.range.start >= 0 &&
      element.range.end <= text.length &&
      text.slice(element.range.start, element.range.end) === element.label,
  );
  const segments: Array<{
    text: string;
    start: number;
    end: number;
    element?: ComposerTextElement;
  }> = [];
  let cursor = 0;
  for (const element of ordered) {
    if (element.range.start > cursor) {
      segments.push({
        text: text.slice(cursor, element.range.start),
        start: cursor,
        end: element.range.start,
      });
    }
    segments.push({
      text: text.slice(element.range.start, element.range.end),
      start: element.range.start,
      end: element.range.end,
      element,
    });
    cursor = element.range.end;
  }
  if (cursor < text.length) {
    segments.push({
      text: text.slice(cursor),
      start: cursor,
      end: text.length,
    });
  }
  if (segments.length === 0) {
    return [{ text: '', start: 0, end: 0 }];
  }
  return segments;
}

function sortElements(elements: ComposerTextElement[]) {
  return [...elements].sort((a, b) => a.range.start - b.range.start);
}
