# demo-zukhruf-durable-turns

The **durable-turns** showcase for the `zukhruf` harness
(`@deepagents/experimental/zukhruf`). The file layout _is_ the configuration:

- `agent.ts` — the root declaration (model + sandbox + instructions) and the
  `consult_specialist` subagent tool.
- `instructions.ts` — the system prompt fragments.
- `sandbox.ts` — the per-chat backend (Docker, named by `chatId`).
- `subagents/specialist.ts` — a normal context-aware `agent()` exposed to the
  root with `agent.asTool()`.
- `subagents/sandbox.ts` — a lightweight in-memory sandbox for the specialist.
- `run.ts` — the executor showcase: PGlite-backed pg-boss, in-process `work()`,
  enqueue a delegated turn 1, detach mid-stream, enqueue turn 2 into the same
  chat (waits — strict FIFO), `resume()` replays turn 1, then turn 2 streams.
- `files/` — the sandbox workspace seed.

The specialist runs inside the parent turn as an AI SDK tool call. Its work is
therefore covered by the parent turn's persisted stream; it is not enqueued as
a separate Zukhruf turn. The root passes a standalone prompt because
`asTool()` forks the specialist's own context rather than sharing the root
conversation or Docker workspace.

## Reserved declaration slots

`channels/`, `connections/`, `schedules/`, `skills/`, and `tools/` are
**reserved declaration-type slots** kept as structural stubs (each holds a
`.gitkeep`). They mark the intended surface of a zukhruf deployable unit; the
runtime does not wire them yet. `subagents/` now contains the specialist wired
explicitly from `agent.ts`.

## Run

```sh
node demo/zukhruf-durable-turns/run.ts "Use the specialist to explain strict FIFO queues with an example."
```

Requires Docker (the sandbox is a per-chat container) and `OPENAI_API_KEY`.
