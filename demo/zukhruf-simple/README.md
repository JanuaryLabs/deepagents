# demo-zukhruf-simple

The smallest complete Zukhruf deployable unit.

- `agent.ts` declares the agent and its MCP plugin for Chrome DevTools browser tools,
  and writes AI SDK OpenTelemetry spans as Halo-compatible JSONL to `telemetry.jsonl`.
- `instructions.ts` declares its behavior and Socratic plan recitation.
- `sandbox.ts` declares its per-chat sandbox and explicitly uploads this demo's
  local `skills/` directory.
- `skills/<name>/SKILL.md` declares skills discovered from that sandbox once per
  conversation. Only each skill's name, description, and model-visible path are
  persisted; its files remain in the sandbox.
- `stack.ts` defines the lazy queue and store composition.
- `run.ts` constructs and exports `runtime`; `server.ts` initializes its disposable `host` from the stack.
- `server.ts` is the top-level process: it initializes the runtime, starts its
  worker, mounts the authenticated Zukhruf protocol at `/zukhruf/v1` and the
  DevTool UI at `/devtool`, and owns shutdown.
- `channels/`, `connections/`, and `schedules/` remain reserved declaration
  slots. `subagents/` and `tools/` hold declarations imported by `agent.ts`.

Run the browser DevTool from the repository root:

```sh
nx run @deepagents/devtool:build && node --env-file=.env demo/zukhruf-simple/server.ts
```

Open the printed URL, `http://127.0.0.1:4317/devtool`. The declaration's
`fileTelemetry()` plugin records telemetry and exposes authenticated traces;
`server.ts` initializes the runtime and serves one Hono server. Ctrl+C
disposes the server, worker, browser connection, queue, and stores together.

## WebMCP

Install Google Chrome 150 or newer. The demo launches its own visible Chrome
window on the first browser tool call, with WebMCP enabled automatically. No
Chrome flag or Codex MCP configuration is needed. Its temporary browser profile
is shared across this local demo's chats and discarded when the browser closes.
Sign in to websites in that window when needed.

Try this in the DevTool chat:

> Open https://googlechromelabs.github.io/webmcp-tools/demos/explainer/ and use its
> WebMCP tools to find available appointments on September 15, 2026. Do not book one.

The agent opens the page with `new_page`, discovers website tools with
`list_webmcp_tools`, then calls `execute_webmcp_tool` using the discovered schema.
The MCP plugin supplies every tool exposed by the server, including tab management,
screenshots, and page interaction. Each runtime connects during initialization and
owns its connection until disposal; importing the declaration does not connect.
Websites must expose WebMCP tools for this to work; the demo does not add tools to
arbitrary websites. Chrome runs on the demo host, alongside the MCP connection.

Run the integration test (requires installed Chrome; no model API key needed):

```sh
nx run @deepagents/demo-zukhruf-simple:test
```
