# demo-zukhruf-durable-turns

The **durable-turns** showcase for the `zukhruf` harness
(`@deepagents/experimental/zukhruf`). The file layout _is_ the configuration:

- `agent.ts` — the agent declaration (model + sandbox + instructions).
- `instructions.ts` — the system prompt fragments.
- `sandbox.ts` — the per-chat backend (Docker, named by `chatId`).
- `run.ts` — the executor showcase: PGlite-backed pg-boss, in-process `work()`,
  enqueue turn 1, detach mid-stream, enqueue turn 2 into the same chat (waits —
  strict FIFO), `resume()` replays turn 1, then turn 2 streams.
- `files/` — the sandbox workspace seed.

## Reserved declaration slots

`channels/`, `connections/`, `schedules/`, `skills/`, `subagents/`, and
`tools/` are **reserved declaration-type slots** kept as structural stubs
(each holds a `.gitkeep`). They mark the intended surface of a zukhruf
deployable unit; the runtime does not wire them yet.

## Run

```sh
node demo/zukhruf-durable-turns/run.ts "List the numbers 1 through 5, one per line."
```

Requires Docker (the sandbox is a per-chat container) and `OPENAI_API_KEY`.
