import { DictationError, type DictationErrorCode } from './DictationError.ts';

export type DictationTranscribe = (
  audio: Blob,
  options: { signal: AbortSignal },
) => Promise<{ text: string }>;

export type DictationSessionSnapshot =
  | { status: 'starting' }
  | { status: 'recording' }
  | { status: 'finishing' }
  | { status: 'ended' }
  | { status: 'failed'; error: DictationError };

type CapturingPhase = {
  status: 'recording' | 'stopping';
  stream: MediaStream;
  recorder: MediaRecorder;
};

type Phase =
  | { status: 'starting' }
  | CapturingPhase
  | { status: 'transcribing' }
  | { status: 'ended' }
  | { status: 'failed'; error: DictationError };

type FinalPhase = Extract<Phase, { status: 'ended' | 'failed' }>;

const deviceErrorCodes = new Map<string, DictationErrorCode>([
  ['NotAllowedError', 'permission-denied'],
  ['NotFoundError', 'no-microphone'],
  ['NotReadableError', 'microphone-in-use'],
]);

function snapshotOf(phase: Phase): DictationSessionSnapshot {
  switch (phase.status) {
    case 'starting':
    case 'ended':
      return { status: phase.status };
    case 'recording':
      return { status: 'recording' };
    case 'stopping':
    case 'transcribing':
      return { status: 'finishing' };
    case 'failed':
      return { status: 'failed', error: phase.error };
  }
}

/**
 * One dictation attempt, from the start to its end: the microphone, the
 * recorder, the transcription of the clip, and the one abort that drops them.
 */
export class DictationSession {
  #phase: Phase = { status: 'starting' };
  #snapshot: DictationSessionSnapshot = { status: 'starting' };
  readonly #abort = new AbortController();
  readonly #listeners = new Set<() => void>();
  readonly #transcriptListeners = new Set<(text: string) => void>();
  readonly #transcribe: DictationTranscribe;

  private constructor(transcribe: DictationTranscribe) {
    this.#transcribe = transcribe;
  }

  static start(transcribe: DictationTranscribe): DictationSession {
    const session = new DictationSession(transcribe);
    void session.#open();
    return session;
  }

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): DictationSessionSnapshot => this.#snapshot;

  onTranscript(listener: (text: string) => void) {
    this.#transcriptListeners.add(listener);
    return () => {
      this.#transcriptListeners.delete(listener);
    };
  }

  stop() {
    const phase = this.#phase;
    if (phase.status === 'starting') {
      this.cancel();
      return;
    }
    if (phase.status !== 'recording') {
      return;
    }
    this.#set({ ...phase, status: 'stopping' });
    phase.recorder.stop();
  }

  cancel() {
    this.#finish({ status: 'ended' });
  }

  async #open() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const code =
        error instanceof DOMException
          ? deviceErrorCodes.get(error.name)
          : undefined;
      if (!code) {
        throw error;
      }
      this.#finish({
        status: 'failed',
        error: new DictationError(code, { cause: error }),
      });
      return;
    }
    const { signal } = this.#abort;
    if (signal.aborted) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.addEventListener(
      'dataavailable',
      (event) => {
        chunks.push(event.data);
      },
      { signal },
    );
    recorder.addEventListener(
      'stop',
      () => {
        if (this.#phase.status !== 'stopping') {
          return;
        }
        void this.#transcribeClip(
          new Blob(chunks, { type: recorder.mimeType }),
        );
      },
      { signal },
    );
    recorder.addEventListener(
      'error',
      (event) => {
        this.#finish({
          status: 'failed',
          error: new DictationError('interrupted', { cause: event }),
        });
      },
      { signal },
    );
    for (const track of stream.getAudioTracks()) {
      track.addEventListener(
        'ended',
        () => {
          this.#finish({
            status: 'failed',
            error: new DictationError('interrupted'),
          });
        },
        { signal },
      );
    }
    recorder.start();
    this.#set({ status: 'recording', stream, recorder });
  }

  async #transcribeClip(clip: Blob) {
    this.#releaseDevices();
    this.#set({ status: 'transcribing' });
    const { signal } = this.#abort;
    try {
      const { text } = await this.#transcribe(clip, { signal });
      if (signal.aborted) {
        return;
      }
      for (const listener of this.#transcriptListeners) {
        listener(text);
      }
    } catch (cause) {
      if (signal.aborted) {
        return;
      }
      this.#finish({
        status: 'failed',
        error: new DictationError('transcription-failed', { cause }),
      });
      return;
    }
    this.#finish({ status: 'ended' });
  }

  #releaseDevices() {
    const phase = this.#phase;
    if (phase.status !== 'recording' && phase.status !== 'stopping') {
      return;
    }
    if (phase.recorder.state !== 'inactive') {
      phase.recorder.stop();
    }
    for (const track of phase.stream.getTracks()) {
      track.stop();
    }
  }

  #finish(next: FinalPhase) {
    const { status } = this.#phase;
    if (status === 'ended' || status === 'failed') {
      return;
    }
    this.#abort.abort();
    this.#releaseDevices();
    this.#set(next);
  }

  #set(phase: Phase) {
    this.#phase = phase;
    this.#snapshot = snapshotOf(phase);
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
