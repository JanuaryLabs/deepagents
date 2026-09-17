# demo-zukhruf-durable-turns

The **durable-turns** showcase for the Zukhruf harness
(`@deepagents/experimental/zukhruf`). The file layout _is_ the configuration:

- `agent.ts` — the root declaration and its permitted `specialist` subagent.
- `instructions.ts` — the system prompt fragments.
- `sandbox.ts` — the per-chat backend (Docker, named by `chatId`).
- `subagents/specialist/` — a self-contained independent `defineAgent()`
  declaration with its own instructions, skills, sandbox, durable chat,
  history, stream, mailbox, and TurnQueue key.
- `stack.ts` — the lazy persistent PGlite queue and SQLite stores.
- `run.ts` — the executor showcase: explicit runtime composition, concurrent
  in-process `work()`, detach/resume the root turn, and print every
  conversation status change the runtime publishes for the root and the
  specialist.
- `files/` — the sandbox workspace seed.

The root calls the implicit `spawn_agent` collaboration tool. It returns
immediately after creating the specialist chat and enqueuing its first turn.
Every spawn sets `fork_turns` to choose `all`, `none`, or a positive count of
recent user-turn boundaries. This demo uses `none` because the specialist
receives a standalone task.
The specialist runs independently and sends its terminal text back as
queue-only `FINAL_ANSWER` mail. As in Codex, that mail never wakes an idle
parent, so the root calls `wait_agent` inside the same turn; the next model
step drains the mailbox and the result becomes part of the root's history
before the model samples. The host does not poll the mailbox or start a second
turn: it subscribes to `runtime.subscribeConversationStatus()` and watches the
root and the specialist go `active` and `idle`.

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
