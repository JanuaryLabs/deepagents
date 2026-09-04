# demo-zukhruf-schedules

A Zukhruf Scheduled Tasks agent managed from the browser DevTool.

- `agent.ts` composes the declaration and its scheduling and telemetry plugins.
- `instructions.ts` declares the scheduled worker behavior.
- `sandbox.ts` declares its per-conversation virtual sandbox.
- `run.ts` initializes the runtime, queue, stores, and schedule bindings.
- `server.ts` mounts Zukhruf, scheduled-task, trace, and DevTool HTTP routes.
- `channels/`, `connections/`, `skills/`, `subagents/`, and `tools/` are
  reserved declaration slots. `schedules/` is available for schedule files if
  this demo later installs `scheduleFiles()`.

Run the browser DevTool from the repository root:

```sh
nx run @deepagents/devtool:build && node --env-file=.env demo/zukhruf-schedules/server.ts
```
