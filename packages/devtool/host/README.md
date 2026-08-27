# `@deepagents/devtool`

Development-only Zukhruf runtime plugin. Its browser UI is bundled into the
package and served from a loopback-only HTTP listener; consumers do not import
React or CSS.

```sh
npm install --save-dev @deepagents/devtool
```

Keep durable telemetry and the devtool definition on the agent declaration:

```ts
import { createFileTelemetry } from '@deepagents/context/telemetry/file';

const developerTool =
  process.env.NODE_ENV === 'development'
    ? (await import('@deepagents/devtool')).devtool()
    : undefined;

const root = defineAgent({
  // ...
  telemetry: {
    integrations: createFileTelemetry({ path: './telemetry.jsonl' }),
  },
  plugins: developerTool ? [developerTool] : [],
});

const runtime = new AgentRuntime(root, {
  ...runtimeOptions,
});

await using work = await runtime.work();
if (developerTool) console.info(runtime.plugin(developerTool).url?.href);
```

The devtool listener is loopback-only. Its `GET /zukhruf/v1/info` response
advertises the existing telemetry source:

```json
{
  "traces": { "path": "file:///absolute/path/to/telemetry.jsonl" }
}
```

The URI scheme selects the devtool adapter. The `file:` adapter runs in the
Node devtool process, projects that JSONL in place, and creates no trace store.
The browser never fetches a `file:` URL.

The default address is `http://127.0.0.1:4317/`. Pass `{ port: 0 }` to select
an available port. The URL becomes available after `runtime.work()` resolves
and returns to `undefined` when that work handle is disposed.

The UI discovers History and the optional trace source from the devtool's
`GET /zukhruf/v1/info`. History stays in the left sidebar. When one file source
is discoverable, the underlined **Traces** link beneath each conversation opens
its model steps, tool calls, timings, usage, inputs, outputs, and errors. With
no unambiguous supported source, `/info` omits `traces` and the links are absent.
The **Scheduled** view is present but remains a placeholder until the host
attaches a schedules bridge.

The built-in telemetry integration exposes its public `traces.path` descriptor,
which the devtool plugin projects unchanged. It does not move, replace, or
mutate the declaration's telemetry configuration. Retention, rotation, and
deletion remain properties of that existing file.

For each turn, the devtool plugin adds the runtime's conversation, stream, and
agent identifiers to the discovered integration's start event. This correlation
metadata is not model input and does not require changing the agent declaration.
The devtool honors recording controls and labels disabled payloads as not
recorded.
