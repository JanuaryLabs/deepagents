# demo-zukhruf-simple

The smallest complete Zukhruf deployable unit.

- `agent.ts` declares the agent and writes its current AI trace to
  `telemetry.jsonl`.
- `instructions.ts` declares its behavior and Socratic plan recitation.
- `sandbox.ts` declares its per-chat sandbox and explicitly uploads this demo's
  local `skills/` directory.
- `skills/<name>/SKILL.md` declares skills discovered from that sandbox once per
  conversation. Only each skill's name, description, and model-visible path are
  persisted; its files remain in the sandbox.
- `run.ts` provides the runtime, durable queue, and stores.
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
