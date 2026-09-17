# demo-zukhruf-schedules

A Zukhruf Scheduled Tasks agent managed from the browser DevTool.

- `agent.ts` composes the declaration and its scheduling and telemetry plugins.
- `instructions.ts` declares the scheduled worker behavior.
- `sandbox.ts` declares its per-conversation virtual sandbox.
- `stack.ts` defines the queue, stores, and schedule bindings lazily.
- `run.ts` composes and exports the runtime. `server.ts` starts its worker.
- `server.ts` mounts Zukhruf, scheduled-task, trace, and DevTool HTTP routes.
- `channels/`, `connections/`, `skills/`, `subagents/`, and `tools/` are
  reserved declaration slots. `schedules/` is available for schedule files if
  this demo later installs `scheduleFiles()`.

The demo uses `codex('gpt-5.5')` with your existing Codex ChatGPT login. Run
`codex login` first if needed; no OpenAI API key is required.

Run the browser DevTool from the repository root:

```sh
nx run @deepagents/devtool:build && node demo/zukhruf-schedules/server.ts
```
