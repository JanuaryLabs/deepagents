/**
 * The one class a read throws: the session's file is missing, cannot be read
 * or decoded, or holds no step. The caller's next step is the same for each
 * (a hook does not fire, a miner logs and skips), so they share a class and
 * differ only in `cause` (ADR 0009).
 */
export class SessionReadError extends Error {
  override readonly name = 'SessionReadError';
  readonly path: string;

  constructor(path: string, message: string, options?: { cause?: unknown }) {
    super(`${message}: ${path}`, options);
    this.path = path;
  }
}
