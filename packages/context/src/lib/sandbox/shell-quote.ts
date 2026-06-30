/**
 * POSIX shell single-quote escape: wrap in `'...'`, replace any embedded
 * `'` with `'\''`. Safe for arbitrary content inside `sh -c`.
 *
 * Lives in its own zero-import module so lean consumers such as the
 * `./sandbox/strace` leaf entry can use it without dragging in the
 * installer/runtime surface.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
