# Copied sandbox session code

The container, Microsandbox and Daytona sessions share what all three build
the same way through `src/lib/sandbox/session.ts`: the text calls over the
binary calls, the process control (a kill that runs once, a kill on abort, a
`wait` that rejects with the abort reason), reading a spawned process to its
end, the base directory join, and `createByteReadable`, which splits one
interleaved process output into stdout and stderr (Microsandbox, Daytona and
Docker's `engineProcess`; Apple uses it to drain its two pipes). Each was
extracted at its third copy (2026-11-18, #4215, #4623).

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
