/**
 * A single observed filesystem mutation — the shared output type of file-change
 * tracking. It is producer-agnostic: the strace trace parser and the direct
 * `writeFiles` observer both emit it. It lives in its own zero-import module so
 * the lean `./sandbox/strace` leaf and the framework decorator can each depend
 * on it without either owning the other.
 *
 * Ops are deliberately coarse — content-touching changes collapse to `write`
 * (the strace producer cannot distinguish a brand-new file from an overwrite;
 * both are `O_CREAT|O_TRUNC`), while `delete` and `rename` are unambiguous.
 * Reads are not tracked.
 */
export type FileChangeOp = 'write' | 'delete' | 'rename';

export interface FileChange {
  op: FileChangeOp;
  path: string;
  /** Source path for a `rename`. */
  from?: string;
  timestamp: number;
}
