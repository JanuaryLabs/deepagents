import { type UIMessage, isTextUIPart } from 'ai';
import { Check, Copy } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';

import { cn } from '@deepagents/react-shadcn';

import { TheButton } from '../ui/TheButton.tsx';
import { COPY_EXCLUSION_MODES } from './copy-image.ts';
import { SnapshotRenderContext } from './snapshot-context.ts';
import { SnapshotRenderPortal, waitForNextPaint } from './snapshot-render.tsx';
import { useCopyElementAsImage } from './use-copy-element-as-image.ts';

export function extractAssistantRawText(message: UIMessage): string {
  return message.parts
    .filter(isTextUIPart)
    .map((part) => part.text)
    .join('\n');
}

export function useIsAssistantSnapshotRender() {
  return useContext(SnapshotRenderContext);
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

  let label = 'Copy snapshot';
  if (isCopying) {
    label = 'Copying snapshot';
  } else if (feedback?.kind === 'success') {
    label = feedback.mode === 'image' ? 'Copied snapshot' : 'Copied text';
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
          <span className="text-destructive text-xs">{feedback.message}</span>
        )}
        <TheButton
          type="button"
          size="icon-sm"
          variant="ghost"
          loading={isCopying}
          onClick={handleCopy}
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
