# demo-zukhruf-research-bot

An asynchronous **multi-agent research bot** on the Zukhruf background agent
runtime (`@deepagents/experimental/zukhruf`). It uses independent conversations
and durable mailboxes instead of blocking `agent.asTool()` calls.

```text
/root
  └─ planner
       ├─ source-1 (researcher)
       ├─ source-2 (researcher)
       └─ source-3 (researcher)
```

The root calls the implicit `spawn_agent` tool and immediately returns control
to the user. Its planner runs in a separate chat, chooses three complementary
research angles, and spawns three independent researcher chats. Each researcher
uses OpenAI's hosted `web_search`, then calls `send_message` with the canonical
target `/root`. Successful researcher turns also return `FINAL_ANSWER` to their
direct parent planner. Spawned agents inherit forked parent-turn history by
default; `fork_turns` can choose all history, none, or a bounded number of recent
user-turn boundaries.

Nothing waits for a child agent. The interactive CLI keeps the worker alive
while the user remains free to send more root turns. Every later root turn
drains whatever researcher messages are durably queued at that point; findings
that arrive afterward remain available for another turn.

The root can call `list_agents` at any time to observe the complete tree. The
tool reports canonical paths plus `pending_init`, `running`,
`{ completed: string | null }`, `{ errored: string }`, or `interrupted` state
without waking agents or consuming mailbox content. Agents paused on approval
remain `running` until the continuation settles.

The CLI renders the root turn stream only. Child chunks are not multiplexed
into the root terminal; child progress is visible through `list_agents`, and
their durable messages/results become visible to the root on later turns.

## Files

- `agent.ts` — the root declaration and its permitted planner subagent.
- `instructions.ts` — root dispatch and report-synthesis behavior.
- `subagents/planner.ts` — an independent planner declaration whose permitted
  subagent is the researcher.
- `subagents/researcher.ts` — an independent web researcher that sends sourced
  findings directly to `/root`.
- `sandbox.ts` and `subagents/sandbox.ts` — per-chat in-memory sandboxes.
- `run.ts` — one concurrent worker plus an interactive root conversation.

## Run

```sh
OPENAI_API_KEY=… node demo/zukhruf-research-bot/run.ts \
  "What are the most promising approaches to grid-scale energy storage in 2026?"
```

The first root response only confirms delegation. Leave the process running
while the planner and researchers work. You can inspect progress without
blocking:

```text
List the current agents and their statuses.
```

Then ask for the available results:

```text
Synthesize every researcher finding received so far into a detailed report.
```

The demo is Docker-free: the queue uses PGlite and every agent gets its own
virtual sandbox. Each invocation starts a fresh root tree, avoiding agent-path
collisions with earlier runs.
