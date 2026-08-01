# demo-zukhruf-simple

The smallest complete Zukhruf deployable unit.

- `agent.ts` declares the agent.
- `instructions.ts` declares its behavior and plan recitation.
- `sandbox.ts` declares its per-chat sandbox and explicitly uploads this demo's
  local `skills/` directory.
- `skills/<name>/SKILL.md` declares skills discovered from that sandbox once per
  conversation. Only each skill's name, description, and model-visible path are
  persisted; its files remain in the sandbox.
- `run.ts` provides the runtime, durable queue, and stores.
- `channels/`, `connections/`, and `schedules/` remain reserved declaration
  slots. `subagents/` and `tools/` hold declarations imported by `agent.ts`.

```sh
OPENAI_API_KEY=… npm start --workspace @deepagents/demo-zukhruf-simple -- \
  "Explain Zukhruf in one sentence."
```
