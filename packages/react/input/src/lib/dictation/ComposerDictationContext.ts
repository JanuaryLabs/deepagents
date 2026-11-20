import { createContext, use } from 'react';

import { useComposerContext } from '../ComposerContext.ts';
import type { DictationError } from './DictationError.ts';

export type ComposerDictation = {
  transcribe: (
    audio: Blob,
    options: { signal: AbortSignal },
  ) => Promise<{ text: string }>;
};

export type DictationEnd = 'insert' | 'send';

export type DictationState =
  | { status: 'unavailable'; reason: 'unsupported' | 'blocked' }
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'recording' }
  | { status: 'finishing'; end: DictationEnd }
  | { status: 'failed'; error: DictationError };

export type ComposerDictationApi = {
  state: DictationState;
  start: () => void;
  stop: () => void;
  cancel: () => void;
};

export const ComposerDictationContext =
  createContext<ComposerDictationApi | null>(null);

export function useComposerDictation(
  componentName = 'useComposerDictation',
): ComposerDictationApi {
  useComposerContext(componentName);
  const dictation = use(ComposerDictationContext);
  if (!dictation) {
    throw new Error(
      `${componentName} needs the dictation prop of Composer.Root.`,
    );
  }
  return dictation;
}
