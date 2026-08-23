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

Nothing waits for a child agent. The runtime host only loads these declarations
and keeps the worker alive; it does not create a conversation or submit a turn.

The host also starts `@deepagents/devtool` and prints its loopback URL while the
worker is idle. Open it while the host is running to inspect persisted root
conversations from the History sidebar. Each conversation's underlined
**Traces** link opens its model steps, tool calls, timings, usage, inputs,
outputs, and errors. The declaration's existing `createFileTelemetry()` remains
the owner of `./telemetry.json`; the devtool plugin advertises its absolute
`file:` URI from its own `/zukhruf/v1/info` route and selects the file adapter.
No second trace store is created. Without one discoverable supported source,
the discovery response and UI omit traces.

The root can call `list_agents` at any time to observe the complete tree. The
tool reports canonical paths plus `pending_init`, `running`,
`{ completed: string | null }`, `{ errored: string }`, or `interrupted` state
without waking agents or consuming mailbox content. Agents paused on approval
remain `running` until the continuation settles.

## Files

- `agent.ts` — the root declaration and its permitted planner subagent.
- `instructions.ts` — root dispatch and report-synthesis behavior.
- `subagents/planner.ts` — an independent planner declaration whose permitted
  subagent is the researcher.
- `subagents/researcher.ts` — an independent web researcher that sends sourced
  findings directly to `/root`.
- `sandbox.ts` and `subagents/sandbox.ts` — per-chat in-memory sandboxes.
- `run.ts` — the declaration host, concurrent worker, and devtool lifecycle; it
  contains no turn submission.

## Run

```sh
node demo/zukhruf-research-bot/run.ts
```

The process prints the devtool URL and waits. It never calls `enqueue()`; press
Ctrl+C to stop the worker and devtool.

The demo is Docker-free: the queue uses PGlite and every agent gets its own
virtual sandbox when a turn is supplied by a future external channel.
