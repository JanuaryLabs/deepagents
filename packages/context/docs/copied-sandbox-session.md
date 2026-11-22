# Copied sandbox session code

The container, Microsandbox and Daytona sessions share what all three build
the same way through `src/lib/sandbox/session.ts`: the text calls over the
binary calls, the process control (a kill that runs once, a kill on abort, a
`wait` that rejects with the abort reason), reading a spawned process to its
end, the base directory join, and `createByteReadable`, which splits one
interleaved process output into stdout and stderr (Microsandbox, Daytona and
Docker's `engineProcess`; Apple uses it to drain its two pipes). Each was
extracted at its third copy (2026-11-18, #4215, #4623).

Two parts exist in two places only. Under the Rule of Three each stays copied
until a third place needs it. Until then, mirror every fix in both files and
name both files in the commit.

| Code                                | Copies                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| Buffered `readFile` and `writeFile` | `src/lib/sandbox/container-session.ts`, `src/lib/sandbox/daytona-sandbox.ts` |
| Released-sandbox operation guard    | `src/lib/sandbox/session.ts`, `src/lib/sandbox/container-sandbox.ts`         |

## Buffered `readFile` and `writeFile`

- Same: `readFile` wraps the bytes of `readBinaryFile` in
  `ReadableStream.from([bytes])`; `writeFile` reads the stream to bytes with
  `new Response(content).bytes()` and calls `writeBinaryFile`.
- Differs: nothing. Microsandbox streams both natively through `fs.readStream`
  and `fs.writeStream`, so it is not a copy.

## Released-sandbox operation guard

- Same: a `live` wrapper around the eleven session operations (`run`,
  `spawn`, the five file reads and writes, `stat`, `listDirectory`,
  `deleteFile`) that rejects with a plain `Error` once the sandbox was
  released, then runs the backend's optional `assertCurrent`, then applies
  the operation to the session; the release runs once through a memoized
  promise.
- Differs: `chatSandboxHandle` (session.ts) guards a chat handle: it says the
  handle of the chat is closed and also guards `resume`. The one-off's copy
  (`ContainerSandboxStrategy.createSandboxMethods`, container-sandbox.ts) says
  the sandbox is disposed and names its container, has no `resume`, and reads
  `assertCurrent` off the `EngineContainer` (only the Apple engine has one: its
  CLI reaches a container by name, so a removed container reads as a failed
  command).
- The third place is likely the Microsandbox or Daytona one-off, once a
  disposed one rejects every operation (#5132 S2 steps 7 and 8).
