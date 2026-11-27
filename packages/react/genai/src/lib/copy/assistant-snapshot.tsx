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
  urlCitationsOf,
} from '../chat/citations.ts';
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

// A custom element's name holds a hyphen (copy of normalizeStreamdownChildren's
// customTagTest default, strike 2, #6005); a quoted attribute value may hold '>'.
const CUSTOM_ELEMENT_TAG =
  /<\/?[a-z][\w]*-[\w-]*(?:\s+[^\s"'>/=]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>/gi;
const CODE = /(```[\s\S]*?```|`[^`\n]+`)/;

// The screen draws a custom element as its component, or not at all when the
// host does not declare it, so the copy drops its tags and keeps the words a
// paired one wraps. Code shows its text as written, so it keeps it.
function withoutCustomElementTags(text: string): string {
  return text
    .split(CODE)
    .map((segment, i) =>
      i % 2 === 1
        ? segment
        : segment
            .replace(CUSTOM_ELEMENT_TAG, '\0')
            .replace(/ \0(?= )/g, '')
            .replaceAll('\0', ''),
    )
    .join('');
}

/**
 * The answer's text with each citation as `[n]` where it sits, then one line
 * per source, numbered as the answer draws them.
 */
export function extractAssistantRawText(message: UIMessage): string {
  const sources = extractSourcesFromMessage(message);
  const text = message.parts
    .filter(isTextUIPart)
    .map((part) =>
      withoutCustomElementTags(
        // Copy of placeCitations' insertion in message-parts.tsx (strike 2, #6040).
        citationsInReadingOrder(part.text, urlCitationsOf(part.citations))
          .reverse()
          .reduce(
            (marked, { at, citation }) =>
              `${marked.slice(0, at)}[${citationIndexOf(sources, citation.source.url)}]${marked.slice(at)}`,
            part.text,
          ),
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
  renderContent,
  className,
}: {
  message: UIMessage;
  renderContent: () => ReactNode;
  className?: string;
}) {
  const snapshotRef = useRef<HTMLDivElement>(null);
  const t = useGenaiMessages();
  const [showSnapshot, setShowSnapshot] = useState(false);
  const fallbackText = useMemo(
    () => extractAssistantRawText(message),
    [message],
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
