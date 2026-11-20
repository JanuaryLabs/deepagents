import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import type {
  ComposerDictation,
  ComposerDictationApi,
  DictationEnd,
  DictationState,
} from './ComposerDictationContext.ts';
import { DictationError } from './DictationError.ts';
import { MicrophonePermission } from './MicrophonePermission.ts';
import { Recording, type RecordingSnapshot } from './Recording.ts';

export type DictationController = {
  api: ComposerDictationApi;
  endWithSend: () => boolean;
};

type TranscriptionRequest = {
  clip: Blob;
  attempt: number;
  transcribe: ComposerDictation['transcribe'];
};

type TranscriptionOutcome = {
  attempt: number;
  failure: DictationError | null;
};

const subscribeToNothing = () => () => undefined;
const noRecording: RecordingSnapshot = { status: 'ended' };
const getNoRecording = () => noRecording;
const getUnknownPermission = () => 'unknown' as const;

export function useDictationController({
  dictation,
  disabled,
  insertTranscript,
  submitDraft,
}: {
  dictation: ComposerDictation | undefined;
  disabled: boolean;
  insertTranscript: (transcript: string) => void;
  submitDraft: () => void;
}): DictationController | null {
  const supported =
    'MediaRecorder' in globalThis && 'mediaDevices' in navigator;
  const offered = dictation !== undefined;
  const [permission] = useState(() => new MicrophonePermission());
  const permissionState = useSyncExternalStore(
    offered && supported ? permission.subscribe : subscribeToNothing,
    permission.getSnapshot,
    getUnknownPermission,
  );
  const [recording, setRecording] = useState<Recording | null>(null);
  const recordingSnapshot = useSyncExternalStore(
    recording ? recording.subscribe : subscribeToNothing,
    recording ? recording.getSnapshot : getNoRecording,
    getNoRecording,
  );
  const [attempt, setAttempt] = useState(0);
  const [end, setEnd] = useState<DictationEnd>('insert');
  const endRef = useRef<DictationEnd>('insert');
  const abortRef = useRef<AbortController | null>(null);
  const latestRef = useRef({ dictation, insertTranscript, submitDraft });

  useEffect(() => {
    latestRef.current = { dictation, insertTranscript, submitDraft };
  });

  const [outcome, transcribeClip, transcribing] = useActionState(
    async (
      _previous: TranscriptionOutcome,
      request: TranscriptionRequest,
    ): Promise<TranscriptionOutcome> => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const { text } = await request.transcribe(request.clip, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          const transcript = text.trim();
          if (transcript) {
            latestRef.current.insertTranscript(transcript);
          }
          if (endRef.current === 'send') {
            latestRef.current.submitDraft();
          }
        }
        return { attempt: request.attempt, failure: null };
      } catch (cause) {
        if (controller.signal.aborted) {
          return { attempt: request.attempt, failure: null };
        }
        return {
          attempt: request.attempt,
          failure: new DictationError('transcription-failed', { cause }),
        };
      }
    },
    { attempt: 0, failure: null },
  );

  useEffect(() => {
    if (disabled || !offered) {
      recording?.cancel();
      abortRef.current?.abort();
    }
  }, [disabled, offered, recording]);

  useEffect(
    () => () => {
      recording?.cancel();
      abortRef.current?.abort();
    },
    [recording],
  );

  if (!dictation) {
    return null;
  }

  const state = currentState();
  const active =
    state.status === 'starting' ||
    state.status === 'recording' ||
    state.status === 'finishing';

  function currentState(): DictationState {
    if (!supported) {
      return { status: 'unavailable', reason: 'unsupported' };
    }
    switch (recordingSnapshot.status) {
      case 'starting':
        return { status: 'starting' };
      case 'recording':
        return { status: 'recording' };
      case 'stopping':
        return { status: 'finishing', end };
      case 'ended':
      case 'failed':
        break;
    }
    if (transcribing) {
      return { status: 'finishing', end };
    }
    if (permissionState === 'denied') {
      return { status: 'unavailable', reason: 'blocked' };
    }
    if (recordingSnapshot.status === 'failed') {
      return { status: 'failed', error: recordingSnapshot.error };
    }
    if (outcome.failure && outcome.attempt === attempt) {
      return { status: 'failed', error: outcome.failure };
    }
    return { status: 'idle' };
  }

  function chooseEnd(next: DictationEnd) {
    endRef.current = next;
    setEnd(next);
  }

  function start() {
    if (disabled || active || state.status === 'unavailable') {
      return;
    }
    const nextAttempt = attempt + 1;
    setAttempt(nextAttempt);
    chooseEnd('insert');
    setRecording(
      Recording.start((clip) => {
        const current = latestRef.current.dictation;
        if (!current) {
          return;
        }
        startTransition(() => {
          transcribeClip({
            clip,
            attempt: nextAttempt,
            transcribe: current.transcribe,
          });
        });
      }),
    );
  }

  function stop() {
    recording?.stop();
  }

  function cancel() {
    recording?.cancel();
    abortRef.current?.abort();
  }

  function endWithSend() {
    switch (state.status) {
      case 'starting':
        recording?.cancel();
        return false;
      case 'recording':
        chooseEnd('send');
        recording?.stop();
        return true;
      case 'finishing':
        chooseEnd('send');
        return true;
      default:
        return false;
    }
  }

  return { api: { state, start, stop, cancel }, endWithSend };
}
