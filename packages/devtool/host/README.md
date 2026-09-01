# `@deepagents/devtool`

Development-only Zukhruf DevTool UI. `devtool()` returns a mountable Hono app
containing only the bundled browser assets and their SPA fallback; consumers do
not import React or CSS, and the DevTool owns no listener, port, runtime
object, credentials, or proxy.

```sh
npm install --save-dev @deepagents/devtool @deepagents/devtool-traces
```

The host owns one Hono server and chooses each plugin's mount. This example
chooses `/zukhruf/v1` for the authenticated HTTP plugin and `/devtool` for the
UI:

```ts
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { devtool } from '@deepagents/devtool';
import { fileTelemetry } from '@deepagents/devtool-traces';
import { tracesHttp } from '@deepagents/devtool-traces/http';
import { AgentRuntime, defineAgent } from '@deepagents/experimental/zukhruf';
import { type HttpEnv, http } from '@deepagents/experimental/zukhruf/http';

const traceTelemetry = fileTelemetry({ path: './telemetry.jsonl' });
const runtime = new AgentRuntime(
  defineAgent({
    ...declaration,
    plugins: [...declaration.plugins, traceTelemetry],
  }),
  runtimeOptions,
);
await using worker = await runtime.work();

const app = new Hono<HttpEnv>();
app.use('/zukhruf/v1/*', (context, next) => {
  context.set('userId', 'demo');
  return next();
});
app.route('/zukhruf/v1', http(runtime, tracesHttp(traceTelemetry)));
app.route('/devtool', devtool({ protocolPath: '/zukhruf/v1' }));

await using server = serve({
  fetch: app.fetch,
  hostname: '127.0.0.1',
  port: 4317,
});
console.info('http://127.0.0.1:4317/devtool');
```

`http(runtime)` uses Hono's effective mount to produce discovery links. For the
example mount, `GET /zukhruf/v1/info` returns:

```json
{
  "capabilities": {
    "history": { "href": "/zukhruf/v1/history" },
    "chat": { "href": "/zukhruf/v1/session" },
    "traces": { "href": "/zukhruf/v1/traces" }
  }
}
```

`history` and `chat` are always advertised by `http(runtime)`. **New Chat**,
conversation loading, streaming, and cancellation use the session protocol on
the current origin, so the host's own authentication middleware guards every
runtime request. Runtime health comes from `GET /zukhruf/v1/health`.

`traces` appears only when the runtime installs the `fileTelemetry()` plugin
from `@deepagents/devtool-traces` and the host passes
`tracesHttp(traceTelemetry)` from `@deepagents/devtool-traces/http` to `http()`.
The plugin instance contributes the AI SDK file telemetry integration and a
transport-neutral trace reader; the definition-bound HTTP projection adds the
runtime's authenticated trace routes and discovery entry. Together they
correlate the conversation, stream, and agent identifiers on each turn, project
the JSONL in place inside the runtime process, and serve
`GET /zukhruf/v1/traces/:chatId` and `GET /zukhruf/v1/traces/:chatId/:traceId`
behind the Zukhruf authentication boundary. Ownership comes from the
authenticated `userId`; the file URI is never exposed and the browser never
sends a user ID. Without the plugin, `/info` omits `traces` and the UI hides
every **Traces** link. Recording controls are honored and disabled payloads are
labelled as not recorded.

`schedules` appears only when the runtime installs `schedules()` and the host
passes `schedulesHttp(scheduled)` from
`@deepagents/experimental/zukhruf/schedules/http` to `http()`. The authenticated
projection provides task creation and editing, pause/resume, archive/purge, Run
now, per-task runs, cancellation, explicit review, and the owner-wide
pending-review inbox. Omitting the projection removes the discovery capability
and hides **Scheduled** navigation.

The UI follows both host-selected Hono mounts. `devtool({ protocolPath })`
injects its effective UI mount as the document base and the same-origin absolute
protocol path as the discovery target. `protocolPath` defaults to
`/zukhruf/v1`. Assets, React Router, deep links, refresh, and Back therefore work
beneath any UI path while runtime requests follow the configured protocol mount.
For this example, `/devtool` and `/devtool/` load the shell, assets load beneath
`/devtool/assets/`, and `/devtool` redirects to `/devtool/history`.
