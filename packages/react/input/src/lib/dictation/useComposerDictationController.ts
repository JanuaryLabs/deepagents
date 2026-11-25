import { useState } from 'react';

import type {
  ComposerDictation,
  ComposerDictationApi,
  ComposerDictationState,
  DictationEnd,
} from './ComposerDictationContext.ts';
import { useDictationSession } from './useDictation.ts';

export type ComposerDictationController = {
  api: ComposerDictationApi;
  endWithSend: () => boolean;
};

/**
 * The composer as one consumer of dictation (ADR 0009): the transcript goes
 * into the editor, and the end `send` then submits the draft (ADR 0008).
 */
export function useComposerDictationController({
  dictation,
  disabled,
  insertTranscript,
  submitDraft,
}: {
  dictation: ComposerDictation | undefined;
  disabled: boolean;
  insertTranscript: (transcript: string) => void;
  submitDraft: () => void;
}): ComposerDictationController | null {
  const [end, setEnd] = useState<DictationEnd>('insert');
  const session = useDictationSession({
    offered: dictation !== undefined,
    disabled,
    onTranscript: (text) => {
      const transcript = text.trim();
      if (transcript) {
        insertTranscript(transcript);
      }
      if (end === 'send') {
        submitDraft();
      }
    },
  });

  if (!dictation) {
    return null;
  }

  const { transcribe } = dictation;
  const state: ComposerDictationState =
    session.state.status === 'finishing'
      ? { status: 'finishing', end }
      : session.state;

  function start() {
    if (session.start(transcribe)) {
      setEnd('insert');
    }
  }

  function endWithSend() {
    switch (state.status) {
      case 'starting':
        session.cancel();
        return false;
      case 'recording':
        setEnd('send');
        session.stop();
        return true;
      case 'finishing':
        setEnd('send');
        return true;
      default:
        return false;
    }
  }

  return {
    api: { state, start, stop: session.stop, cancel: session.cancel },
    endWithSend,
  };
}
