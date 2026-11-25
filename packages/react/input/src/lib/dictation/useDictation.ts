import {
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
} from 'react';

import type { DictationError } from './DictationError.ts';
import {
  DictationSession,
  type DictationTranscribe,
} from './DictationSession.ts';
import { MicrophonePermission } from './MicrophonePermission.ts';

export type DictationOptions = {
  transcribe: DictationTranscribe;
  onTranscript: (text: string) => void;
  disabled?: boolean;
};

export type DictationState =
  | { status: 'unavailable'; reason: 'unsupported' | 'blocked' }
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'recording' }
  | { status: 'finishing' }
  | { status: 'failed'; error: DictationError };

export type DictationApi = {
  state: DictationState;
  start: () => void;
  stop: () => void;
  cancel: () => void;
};

const subscribeToNothing = () => () => undefined;
const getNoSession = () => null;
const getUnknownPermission = () => 'unknown' as const;

/**
 * The sessions of one dictation control. `offered` is false only for a
 * composer whose host passes no `dictation`: no permission query runs, and an
 * active session ends.
 */
export function useDictationSession({
  offered,
  disabled,
  onTranscript,
}: {
  offered: boolean;
  disabled: boolean;
  onTranscript: (text: string) => void;
}) {
  const supported =
    'MediaRecorder' in globalThis && 'mediaDevices' in navigator;
  const [permission] = useState(() => new MicrophonePermission());
  const permissionState = useSyncExternalStore(
    offered && supported ? permission.subscribe : subscribeToNothing,
    permission.getSnapshot,
    getUnknownPermission,
  );
  const [session, setSession] = useState<DictationSession | null>(null);
  const snapshot = useSyncExternalStore(
    session ? session.subscribe : subscribeToNothing,
    session ? session.getSnapshot : getNoSession,
    getNoSession,
  );
  const deliverTranscript = useEffectEvent((text: string) => {
    onTranscript(text);
  });

  useEffect(() => {
    if (!session) {
      return;
    }
    const unsubscribe = session.onTranscript((text) => {
      deliverTranscript(text);
    });
    return () => {
      unsubscribe();
      session.cancel();
    };
  }, [session]);

  useEffect(() => {
    if (disabled || !offered) {
      session?.cancel();
    }
  }, [disabled, offered, session]);

  const state = currentState();
  const active =
    state.status === 'starting' ||
    state.status === 'recording' ||
    state.status === 'finishing';

  function currentState(): DictationState {
    if (!supported) {
      return { status: 'unavailable', reason: 'unsupported' };
    }
    switch (snapshot?.status) {
      case 'starting':
      case 'recording':
      case 'finishing':
        return { status: snapshot.status };
      case 'ended':
      case 'failed':
      case undefined:
        break;
    }
    if (permissionState === 'denied') {
      return { status: 'unavailable', reason: 'blocked' };
    }
    if (snapshot?.status === 'failed') {
      return { status: 'failed', error: snapshot.error };
    }
    return { status: 'idle' };
  }

  function start(transcribe: DictationTranscribe) {
    if (disabled || active || state.status === 'unavailable') {
      return false;
    }
    setSession(DictationSession.start(transcribe));
    return true;
  }

  function stop() {
    session?.stop();
  }

  function cancel() {
    session?.cancel();
  }

  return { state, start, stop, cancel };
}

export function useDictation({
  transcribe,
  onTranscript,
  disabled,
}: DictationOptions): DictationApi {
  const dictation = useDictationSession({
    offered: true,
    disabled: disabled === true,
    onTranscript,
  });
  return {
    state: dictation.state,
    start: () => {
      dictation.start(transcribe);
    },
    stop: dictation.stop,
    cancel: dictation.cancel,
  };
}
