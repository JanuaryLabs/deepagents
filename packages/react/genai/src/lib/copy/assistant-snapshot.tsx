import { TheButton } from '@zukhruf/ui';
import { type UIMessage, isTextUIPart } from 'ai';
import { cn } from 'cn';
import { Check, Copy } from 'lucide-react';
import {
  type ReactNode,
  use,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';

import { citationsInReadingOrder } from '../chat/citation-order.ts';
import {
  citationIndexOf,
  extractSourcesFromMessage,
  joinTextParts,
  urlCitationsOf,
} from '../chat/citations.ts';
import { buildMessageTrajectorySegments } from '../chat/trajectory/trajectory-segments.ts';
import type { GenAIInteractiveElement } from '../elements/interactive-element.ts';
import { useGenaiMessages } from '../i18n/provider.tsx';
import { COPY_EXCLUSION_MODES } from './copy-image.ts';
import { SnapshotRenderContext } from './snapshot-context.ts';
import { SnapshotRenderPortal, waitForNextPaint } from './snapshot-render.tsx';
import {
  type CopyImageFeedback,
  useCopyElementAsImage,
} from './use-copy-element-as-image.ts';

const copyFailures = {
  'clipboard-unavailable': 'snapshot.clipboardUnavailable',
  'image-unsupported': 'snapshot.imageUnsupported',
  failed: 'snapshot.copyFailed',
} as const satisfies Record<
  Extract<CopyImageFeedback, { kind: 'error' }>['reason'],
  string
>;

// A quoted attribute value may hold '>'.
const TAG =
  /<\/?([a-z][\w-]*)(?:\s+[^\s"'>/=]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>/gi;
const CODE = /(```[\s\S]*?```|`[^`\n]+`)/;

// The screen draws a declared element as its component, so the copy drops its
// tags and keeps the words a paired one wraps. Code and any other tag-like
// text keep their text as written.
function withoutElementTags(text: string, declared: Set<string>): string {
  return text
    .split(CODE)
    .map((segment, i) =>
      i % 2 === 1
        ? segment
        : segment
            .replace(TAG, (tag, name: string) =>
              declared.has(name) ? '\0' : tag,
            )
            .replace(/ \0+(?= )/g, '')
            .replaceAll('\0', ''),
    )
    .join('');
}

/**
 * The answer's text with each citation as `[n]` where it sits, then one line
 * per source, numbered as the answer draws them.
 */
export function extractAssistantRawText(
  message: UIMessage,
  elements: readonly Pick<GenAIInteractiveElement, 'name'>[],
): string {
  const sources = extractSourcesFromMessage(message);
  const declared = new Set(elements.map(({ name }) => name));
  // One text per run of consecutive text parts, as the screen draws them.
  const text = buildMessageTrajectorySegments(message.parts)
    .flatMap((segment) =>
      segment.kind === 'text'
        ? [
            joinTextParts(
              segment.parts.flatMap(({ part }) =>
                isTextUIPart(part) ? [part] : [],
              ),
            ),
          ]
        : [],
    )
    .map(({ text, citations }) =>
      withoutElementTags(
        // Copy of placeCitations' insertion in message-parts.tsx (strike 2, #6040).
        citationsInReadingOrder(text, urlCitationsOf(citations))
          .reverse()
          .reduce(
            (marked, { at, citation }) =>
              `${marked.slice(0, at)}[${citationIndexOf(sources, citation.source.url)}]${marked.slice(at)}`,
            text,
          ),
        declared,
      ),
    )
    .join('\n');
  if (sources.length === 0) return text;
  const list = sources.map(
    ({ url, title }, i) => `[${i + 1}] ${title ? `${title} — ` : ''}${url}`,
  );
  return `${text}\n\n${list.join('\n')}`;
}

export function useIsAssistantSnapshotRender() {
  return use(SnapshotRenderContext);
}

export function AssistantSnapshot({
  message,
  elements,
  renderContent,
  className,
}: {
  message: UIMessage;
  /** The elements the host declares, whose tags the copied text drops. */
  elements?: GenAIInteractiveElement[];
  renderContent: () => ReactNode;
  className?: string;
}) {
  const snapshotRef = useRef<HTMLDivElement>(null);
  const t = useGenaiMessages();
  const [showSnapshot, setShowSnapshot] = useState(false);
  const fallbackText = useMemo(
    () => extractAssistantRawText(message, elements ?? []),
    [message, elements],
  );
  const { copy, feedback, isCopying } = useCopyElementAsImage({
    elementRef: snapshotRef,
    excludeMode: COPY_EXCLUSION_MODES.assistantSnapshot,
    fallbackText,
  });

  const handleCopy = useCallback(async () => {
    if (!showSnapshot) {
      setShowSnapshot(true);
    }

    await waitForNextPaint();
    await copy();
  }, [copy, showSnapshot]);

  let label = t('snapshot.copy');
  if (isCopying) {
    label = t('snapshot.copying');
  } else if (feedback?.kind === 'success') {
    label = t(
      feedback.mode === 'image'
        ? 'snapshot.copiedImage'
        : 'snapshot.copiedText',
    );
  }

  return (
    <>
      {showSnapshot && (
        <SnapshotRenderPortal contentRef={snapshotRef}>
          {renderContent()}
        </SnapshotRenderPortal>
      )}
      <div
        data-copy-exclude="assistant-snapshot"
        className={cn('flex items-center gap-2', className)}
      >
        {feedback?.kind === 'error' && (
          <span className="text-destructive text-xs">
            {t(copyFailures[feedback.reason])}
          </span>
        )}
        <TheButton
          type="button"
          size="icon-sm"
          variant="ghost"
          loading={isCopying}
          onClick={() => void handleCopy()}
          aria-label={label}
          icon={
            feedback?.kind === 'success' ? (
              <Check className="size-4" />
            ) : (
              <Copy className="size-4" />
            )
          }
        />
      </div>
    </>
  );
}
