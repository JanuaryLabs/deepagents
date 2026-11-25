import { createContext, use } from 'react';

import { useComposerContext } from '../ComposerContext.ts';
import type { DictationOptions, DictationState } from './useDictation.ts';

export type ComposerDictation = Pick<DictationOptions, 'transcribe'>;

export type DictationEnd = 'insert' | 'send';

export type ComposerDictationState =
  | Exclude<DictationState, { status: 'finishing' }>
  | { status: 'finishing'; end: DictationEnd };

export type ComposerDictationApi = {
  state: ComposerDictationState;
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
