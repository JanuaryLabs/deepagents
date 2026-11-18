# Copied sandbox session code

| Source                                                  | Copy                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| `packages/context/src/lib/sandbox/container-session.ts` | `packages/context/src/lib/sandbox/microsandbox-sandbox.ts` |

Copied on 2026-11-10, when Microsandbox moved onto `DisposableSandbox`.

Docker and Apple share one session, `containerSession`. Microsandbox is the
second place that builds an AI SDK sandbox session over a backend's own
primitives, so it keeps its own copy of what both need. Under the Rule of
Three, the code is extracted when a third place needs it: the Daytona port.
Until then, mirror every fix in both files and name both files in the commit.

Imported, not copied: `FILE_STAT_TYPES` and `bufferEncoding` come from
`container-session.ts`.

## Copied with changes

**Text and stream calls on top of the binary primitives.**

- Same: `readTextFile` reads the bytes with `readBinaryFile`, decodes them with
  `bufferEncoding(encoding)` and cuts the lines with `extractLines`.
  `writeTextFile` encodes with `bufferEncoding(encoding)` and calls
  `writeBinaryFile`.
- Differs: `readFile` and `writeFile`. The container session buffers them
  (`ReadableStream.from([bytes])`, `new Response(content).bytes()`). Microsandbox
  streams them through `fs.readStream` and `fs.writeStream`, because its SDK has
  both and the engines of the containers have neither.

**`wait()` that rejects with the abort reason.**

- Same: `exitCode.finally(() => abortSignal?.throwIfAborted())`. The process
  exits first, then `wait()` rejects with the reason.
- Differs: nothing.

**The abort listener.**

- Same: `onAbort` calls `kill()` and drops its rejection; an already aborted
  signal calls it at once; the listener is removed when the process exits.
- Differs: the container session removes it on `process.exitCode`; Microsandbox
  removes it in the `finally` of its event pump.

**An idempotent `kill()`.**

- Same: a second call shares the first call's promise (`??=`), and a call after
  the exit does nothing.
- Differs: the container session kills the process group through an exec
  (`terminate`). Microsandbox calls `ExecHandle.kill()` and returns early after
  the exit: the SDK fails a kill after the exit with `execution_closed`, within
  milliseconds since 0.7.16, so a second `ExecHandle.kill()` could reject before
  the event pump saw the exit.

**`run` over `spawn`.**

- Same: spawn, read both streams to text, await `wait()`.
- Differs: the container session has a fast path through `exec` when there is no
  signal and no timeout, and `run` adds `throwIfAborted` after the collect.
  Microsandbox always spawns: the SDK's exec stream is its only process
  primitive, and `wait()` already rejects on abort.

**Relative paths against one base directory.**

- Same: joined, not normalized (`` `${workdir}/${path}` ``), so `link/..`
  follows the link, as it does in a command.
- Differs: the container session joins only `workingDirectory`, because its
  engine resolves relative file paths itself. Microsandbox joins every path: its
  filesystem calls resolve relative paths against `/`, and its exec rejects a
  relative `cwd`.

## Not copied

The exec scripts of the container session (`STAT_SCRIPT`, `READ_FILE_SCRIPT`,
`LIST_DIRECTORY_SCRIPT`, `DELETE_FILE_SCRIPT`) and the managed wrapper are not
copied. The Microsandbox SDK has native `stat`, `read`, `list`, `remove` and an
exec kill.

## What the extraction can share

- **As is:** the text calls, `wait()`, the abort listener, the idempotent kill.
- **With parameters:** `run` over `spawn` (the container fast path), the base
  directory join (which paths the backend resolves itself), the stream calls
  (native or buffered).
- **Not shared:** how each backend kills, stats, lists and deletes.
