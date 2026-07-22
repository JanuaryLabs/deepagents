# demo-zukhruf-simple

The smallest complete Zukhruf deployable unit.

- `agent.ts` declares the agent.
- `instructions.ts` declares its behavior.
- `sandbox.ts` declares its per-chat sandbox.
- `run.ts` provides the runtime, durable queue, and stores.
- `channels/`, `connections/`, `schedules/`, `skills/`, `subagents/`, and
  `tools/` are reserved declaration slots.

```sh
OPENAI_API_KEY=… npm start --workspace @deepagents/demo-zukhruf-simple -- \
  "Explain Zukhruf in one sentence."
```
