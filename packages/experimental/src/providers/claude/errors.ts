export type ClaudeAuthErrorCode =
  | 'not-connected'
  | 'refresh-token-invalid'
  | 'refresh-failed'
  | 'invalid-token-response'
  | 'access-token-invalid'
  | 'models-request-failed';

/** Raised by Claude subscription accounts; branch on `code`, not the message. */
export class ClaudeAuthError extends Error {
  readonly code: ClaudeAuthErrorCode;

  constructor(code: ClaudeAuthErrorCode, message: string) {
    super(message);
    this.name = 'ClaudeAuthError';
    this.code = code;
  }
}
