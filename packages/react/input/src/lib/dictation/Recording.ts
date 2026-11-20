import { DictationError, type DictationErrorCode } from './DictationError.ts';

export type RecordingSnapshot =
  | { status: 'starting' }
  | { status: 'recording' }
  | { status: 'stopping' }
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
  | { status: 'ended' }
  | { status: 'failed'; error: DictationError };

type FinalPhase = Extract<Phase, { status: 'ended' | 'failed' }>;

const deviceErrorCodes = new Map<string, DictationErrorCode>([
  ['NotAllowedError', 'permission-denied'],
  ['NotFoundError', 'no-microphone'],
  ['NotReadableError', 'microphone-in-use'],
]);

export class Recording {
  #phase: Phase = { status: 'starting' };
  readonly #listeners = new Set<() => void>();
  readonly #onClip: (clip: Blob) => void;

  private constructor(onClip: (clip: Blob) => void) {
    this.#onClip = onClip;
  }

  static start(onClip: (clip: Blob) => void): Recording {
    const recording = new Recording(onClip);
    void recording.#open();
    return recording;
  }

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): RecordingSnapshot => this.#phase;

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
    if (this.#phase.status !== 'starting') {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.addEventListener('dataavailable', (event) => {
      chunks.push(event.data);
    });
    recorder.addEventListener('stop', () => {
      if (this.#phase.status !== 'stopping') {
        return;
      }
      this.#finish({ status: 'ended' });
      this.#onClip(new Blob(chunks, { type: recorder.mimeType }));
    });
    recorder.addEventListener('error', (event) => {
      this.#finish({
        status: 'failed',
        error: new DictationError('interrupted', { cause: event }),
      });
    });
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        this.#finish({
          status: 'failed',
          error: new DictationError('interrupted'),
        });
      });
    }
    recorder.start();
    this.#set({ status: 'recording', stream, recorder });
  }

  #finish(next: FinalPhase) {
    const phase = this.#phase;
    if (phase.status === 'ended' || phase.status === 'failed') {
      return;
    }
    if (phase.status !== 'starting') {
      if (phase.recorder.state !== 'inactive') {
        phase.recorder.stop();
      }
      for (const track of phase.stream.getTracks()) {
        track.stop();
      }
    }
    this.#set(next);
  }

  #set(phase: Phase) {
    this.#phase = phase;
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
