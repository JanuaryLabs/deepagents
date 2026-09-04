# demo-zukhruf-simple

The smallest complete Zukhruf deployable unit.

- `agent.ts` declares the agent and writes AI SDK OpenTelemetry spans as Halo-compatible JSONL to `telemetry.jsonl`.
- `instructions.ts` declares its behavior and Socratic plan recitation.
- `sandbox.ts` declares its per-chat sandbox and explicitly uploads this demo's
  local `skills/` directory.
- `skills/<name>/SKILL.md` declares skills discovered from that sandbox once per
  conversation. Only each skill's name, description, and model-visible path are
  persisted; its files remain in the sandbox.
- `run.ts` initializes and exports the runtime with its durable queue and stores.
- `server.ts` is the top-level process: it imports the runtime, mounts the
  authenticated Zukhruf protocol at `/zukhruf/v1` and the DevTool UI at
  `/devtool`, and owns shutdown.
- `channels/`, `connections/`, and `schedules/` remain reserved declaration
  slots. `subagents/` and `tools/` hold declarations imported by `agent.ts`.

Run the browser DevTool from the repository root:

```sh
nx run @deepagents/devtool:build && node --env-file=.env demo/zukhruf-simple/server.ts
```

Open the printed URL, `http://127.0.0.1:4317/devtool`. The declaration's
`fileTelemetry()` plugin records telemetry and exposes authenticated traces;
`server.ts` imports the initialized runtime and serves one Hono server. Ctrl+C
disposes the server, worker, queue, and stores together.
