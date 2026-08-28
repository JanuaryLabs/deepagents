# demo-zukhruf-simple

The smallest complete Zukhruf deployable unit.

- `agent.ts` declares the agent and writes telemetry events to `telemetry.jsonl`.
- `instructions.ts` declares its behavior and Socratic plan recitation.
- `sandbox.ts` declares its per-chat sandbox and explicitly uploads this demo's
  local `skills/` directory.
- `skills/<name>/SKILL.md` declares skills discovered from that sandbox once per
  conversation. Only each skill's name, description, and model-visible path are
  persisted; its files remain in the sandbox.
- `run.ts` provides the runtime, durable queue, and stores.
- `server.ts` provides the one HTTP host for `--devtool` mode: the authenticated
  Zukhruf protocol at `/zukhruf/v1` and the DevTool UI at `/devtool`.
- `channels/`, `connections/`, and `schedules/` remain reserved declaration
  slots. `subagents/` and `tools/` hold declarations imported by `agent.ts`.

```sh
node --env-file .env demo/zukhruf-simple/run.ts \
  "Investigate the available Zukhruf skill and explain how its runtime works from sandbox evidence."
```

In another terminal, watch the model steps, tool calls, and recitations:

```sh
tail -f demo/zukhruf-simple/telemetry.jsonl
```

To try the browser DevTool, run this from the repository root:

```sh
npm run devtool --workspace @deepagents/demo-zukhruf-simple
```

Open the printed URL, `http://127.0.0.1:4317/devtool`. The declaration's
`fileTelemetry()` plugin records telemetry and exposes authenticated traces;
`run.ts` starts the worker and `server.ts` serves one Hono server that mounts
the Zukhruf protocol at `/zukhruf/v1` and the DevTool UI at `/devtool`. Ctrl+C
disposes the worker and the server together.
