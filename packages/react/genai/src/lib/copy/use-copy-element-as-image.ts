import type { RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type CopyExclusionMode,
  resolveCopyToClipboardStrategy,
  shouldIncludeInCopyImage,
} from './copy-image.ts';

type CopySuccessMode = 'image' | 'text';

export type CopyImageFeedback =
  | { kind: 'success'; mode: CopySuccessMode }
  | { kind: 'error'; message: string }
  | null;

function resolveImageBackgroundColor(element: HTMLElement): string | undefined {
  const elementBackground = getComputedStyle(element).backgroundColor;
  if (elementBackground !== 'rgba(0, 0, 0, 0)') {
    return elementBackground;
  }

  const bodyBackground = getComputedStyle(document.body).backgroundColor;
  return bodyBackground === 'rgba(0, 0, 0, 0)' ? undefined : bodyBackground;
}

export function useCopyElementAsImage({
  elementRef,
  excludeMode,
  fallbackText,
}: {
  elementRef: RefObject<HTMLElement | null>;
  excludeMode: CopyExclusionMode;
  fallbackText?: string;
}) {
  const [isCopying, setIsCopying] = useState(false);
  const [feedback, setFeedback] = useState<CopyImageFeedback>(null);
  const feedbackTimeoutRef = useRef<number | null>(null);

  const clearFeedbackTimeout = useCallback(() => {
    if (feedbackTimeoutRef.current === null) {
      return;
    }

    window.clearTimeout(feedbackTimeoutRef.current);
    feedbackTimeoutRef.current = null;
  }, []);

  const setTimedFeedback = useCallback(
    (nextFeedback: Exclude<CopyImageFeedback, null>) => {
      clearFeedbackTimeout();
      setFeedback(nextFeedback);
      feedbackTimeoutRef.current = window.setTimeout(() => {
        setFeedback(null);
        feedbackTimeoutRef.current = null;
      }, 3000);
    },
    [clearFeedbackTimeout],
  );

  useEffect(
    () => () => {
      clearFeedbackTimeout();
    },
    [clearFeedbackTimeout],
  );

  const copyText = useCallback(async () => {
    if (
      typeof navigator === 'undefined' ||
      typeof navigator.clipboard?.writeText !== 'function' ||
      !fallbackText ||
      fallbackText.trim().length === 0
    ) {
      return false;
    }

    await navigator.clipboard.writeText(fallbackText);
    setTimedFeedback({ kind: 'success', mode: 'text' });
    return true;
  }, [fallbackText, setTimedFeedback]);

  const copyImage = useCallback(async () => {
    if (!elementRef.current) {
      throw new Error('Nothing is ready to copy yet.');
    }

    const { toBlob } = await import('html-to-image');
    const blob = await toBlob(elementRef.current, {
      backgroundColor: resolveImageBackgroundColor(elementRef.current),
      pixelRatio: 2,
      filter: (node) => shouldIncludeInCopyImage(node, excludeMode),
    });

    if (!blob) {
      throw new Error('Unable to render the image for copying.');
    }

    await navigator.clipboard.write([
      new ClipboardItem({
        [blob.type]: blob,
      }),
    ]);

    setTimedFeedback({ kind: 'success', mode: 'image' });
  }, [elementRef, excludeMode, setTimedFeedback]);

  const copy = useCallback(async () => {
    setIsCopying(true);
    setFeedback(null);

    try {
      const strategy = resolveCopyToClipboardStrategy({
        clipboard:
          typeof navigator === 'undefined' ? undefined : navigator.clipboard,
        ClipboardItem:
          typeof window === 'undefined' ? undefined : window.ClipboardItem,
      });

      if (strategy === 'image') {
        try {
          await copyImage();
          return;
        } catch (error) {
          if (await copyText()) {
            return;
          }

          throw error;
        }
      }

      if (strategy === 'text' && (await copyText())) {
        return;
      }

      setTimedFeedback({
        kind: 'error',
        message:
          strategy === 'none'
            ? 'Clipboard access is not available here.'
            : 'Image copy is not supported in this browser.',
      });
    } catch {
      setTimedFeedback({
        kind: 'error',
        message: 'Copy failed. Please try again.',
      });
    } finally {
      setIsCopying(false);
    }
  }, [copyImage, copyText, setTimedFeedback]);

  return { copy, feedback, isCopying };
}
