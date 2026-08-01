# demo-zukhruf-durable-turns

The **durable-turns** showcase for the Zukhruf harness
(`@deepagents/experimental/zukhruf`). The file layout _is_ the configuration:

- `agent.ts` — the root declaration and its permitted `specialist` subagent.
- `instructions.ts` — the system prompt fragments.
- `sandbox.ts` — the per-chat backend (Docker, named by `chatId`).
- `subagents/specialist/` — a self-contained independent `defineAgent()`
  declaration with its own instructions, skills, sandbox, durable chat,
  history, stream, mailbox, and TurnQueue key.
- `run.ts` — the executor showcase: PGlite-backed pg-boss, concurrent
  in-process `work()`, detach/resume the root turn, wait for the independently
  queued child completion, then enqueue a second root turn that drains it.
- `files/` — the sandbox workspace seed.

The root calls the implicit `spawn_agent` collaboration tool. It returns
immediately after creating the specialist chat and enqueuing its first turn.
By default, the child starts with the root's forked parent-turn history; hosts
can pass `fork_turns` to choose `all`, `none`, or a positive count of recent
user-turn boundaries.
The specialist runs independently and sends its terminal text back as
queue-only `FINAL_ANSWER` mail. The demo waits until that completion is durable,
then starts a second root turn. Normal mailbox draining makes the result part of
the root's history before the model samples.

The root and specialist deliberately use different sandboxes. The root keeps a
per-chat Docker workspace, while the specialist gets a private in-memory
sandbox and never inherits the root conversation or filesystem.

## Reserved declaration slots

`skills/<name>/SKILL.md` is native inside the sandbox: Zukhruf discovers the
sandbox's catalog once per conversation and exposes relative skill paths to the
model. The sandbox provider owns how those files arrive. The specialist uses
`uploadDirectory` explicitly for its demo-local `skills/`; production providers
can preinstall or mount the same layout. The root has no skills, while the
specialist owns `explain-fifo`. Chat metadata retains only each skill's name,
description, and model-visible path; full skill files remain in the sandbox.

`channels/`, `connections/`, and `schedules/` remain unwired structural stubs.
`tools/` is reserved for declarations imported by `agent.ts`. Each directory
under `subagents/` is another self-contained agent declaration with its own
optional `skills/`.

## Run

```sh
node demo/zukhruf-durable-turns/run.ts "Use the specialist to explain strict FIFO queues with an example."
```

Requires Docker (the sandbox is a per-chat container) and `OPENAI_API_KEY`.
