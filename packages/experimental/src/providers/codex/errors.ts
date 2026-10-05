export type CodexAuthErrorCode =
  | 'not-connected'
  | 'refresh-token-invalid'
  | 'refresh-failed'
  | 'missing-account-id'
  | 'access-token-invalid'
  | 'models-request-failed';

/** Raised by ChatGPT subscription accounts; branch on `code`, not the message. */
export class CodexAuthError extends Error {
  readonly code: CodexAuthErrorCode;

  constructor(code: CodexAuthErrorCode, message: string) {
    super(message);
    this.name = 'CodexAuthError';
    this.code = code;
  }
}
