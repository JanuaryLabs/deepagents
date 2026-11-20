export type DictationErrorCode =
  | 'permission-denied'
  | 'no-microphone'
  | 'microphone-in-use'
  | 'interrupted'
  | 'transcription-failed';

export class DictationError extends Error {
  readonly code: DictationErrorCode;

  constructor(code: DictationErrorCode, options?: ErrorOptions) {
    super(`Dictation failed: ${code}`, options);
    this.name = 'DictationError';
    this.code = code;
  }
}
