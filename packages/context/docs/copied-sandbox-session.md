# Copied sandbox session code

The container, Microsandbox and Daytona sessions share what all three build
the same way through `src/lib/sandbox/session.ts`: the text calls over the
binary calls, the process control (a kill that runs once, a kill on abort, a
`wait` that rejects with the abort reason), reading a spawned process to its
end, the base directory join, and `createByteReadable`, which splits one
interleaved process output into stdout and stderr (Microsandbox, Daytona and
Docker's `engineProcess`; Apple uses it to drain its two pipes). Each was
extracted at its third copy (2026-11-18, #4215, #4623).

The released-sandbox operation guard, `guardSession`, was extracted at its
third place (#5132 S2 step 7, #5372): the chat handle (`chatSandboxHandle`),
the container one-off (`ContainerSandboxStrategy.createSandboxMethods`) and
the Microsandbox one-off (`createMicrosandboxSandbox`). It wraps the eleven
session operations so that each rejects with a plain `Error` once the sandbox
was released and otherwise runs the backend's optional `assertCurrent` first,
and it runs the release once. The message and `assertCurrent` are its
parameters; the chat handle's `resume` and the one-offs' `dispose` stay with
each consumer. The Daytona one-off (`createDaytonaSandbox`, #5132 S2 step 8)
is its fourth consumer.

One part exists in two places only. Under the Rule of Three it stays copied
until a third place needs it. Until then, mirror every fix in both files and
name both files in the commit.

| Code                                | Copies                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| Buffered `readFile` and `writeFile` | `src/lib/sandbox/container-session.ts`, `src/lib/sandbox/daytona-sandbox.ts` |

## Buffered `readFile` and `writeFile`

- Same: `readFile` wraps the bytes of `readBinaryFile` in
  `ReadableStream.from([bytes])`; `writeFile` reads the stream to bytes with
  `new Response(content).bytes()` and calls `writeBinaryFile`.
- Differs: nothing. Microsandbox streams both natively through `fs.readStream`
  and `fs.writeStream`, so it is not a copy.
