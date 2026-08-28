# `@deepagents/devtool`

Development-only Zukhruf DevTool UI. `devtool()` returns a mountable Hono app
containing only the bundled browser assets and their SPA fallback; consumers do
not import React or CSS, and the DevTool owns no listener, port, runtime
object, runtime URL, credentials, or proxy.

```sh
npm install --save-dev @deepagents/devtool @deepagents/devtool-traces
```

The host owns one Hono server. It mounts the authenticated Zukhruf protocol at
`/zukhruf/v1` and the DevTool UI at `/devtool` on the same origin:

```ts
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { DEVTOOL_ROUTE_PREFIX, devtool } from '@deepagents/devtool';
import { fileTelemetry } from '@deepagents/devtool-traces';
import {
  AgentRuntime,
  ZUKHRUF_ROUTE_PREFIX,
  defineAgent,
  zukhruf,
} from '@deepagents/experimental/zukhruf';

const runtime = new AgentRuntime(
  defineAgent({
    ...declaration,
    plugins: [
      ...declaration.plugins,
      fileTelemetry({ path: './telemetry.jsonl' }),
    ],
  }),
  runtimeOptions,
);
await using worker = await runtime.work();

const app = new Hono<{ Variables: { userId: string } }>();
app.use(`${ZUKHRUF_ROUTE_PREFIX}/*`, async (context, next) => {
  context.set('userId', 'demo');
  await next();
});
app.route(ZUKHRUF_ROUTE_PREFIX, zukhruf(runtime));
app.route(DEVTOOL_ROUTE_PREFIX, devtool());

await using server = serve({
  fetch: app.fetch,
  hostname: '127.0.0.1',
  port: 4317,
});
console.info('http://127.0.0.1:4317/devtool');
```

The browser discovers everything through same-origin `GET /zukhruf/v1/info`:

```json
{
  "capabilities": {
    "history": { "href": "/zukhruf/v1/history" },
    "chat": { "href": "/zukhruf/v1/session" },
    "traces": { "href": "/zukhruf/v1/traces" }
  }
}
```

`history` and `chat` are always advertised by `zukhruf(runtime)`. **New Chat**,
conversation loading, streaming, and cancellation use the session protocol on
the current origin, so the host's own authentication middleware guards every
runtime request. Runtime health comes from `GET /zukhruf/v1/health`.

`traces` appears only when the runtime installs the `fileTelemetry()` plugin
from `@deepagents/devtool-traces`. The plugin contributes the AI SDK file
telemetry integration, adds the runtime's conversation, stream, and agent
identifiers to each turn's start event, projects the JSONL in place inside the
runtime process, and serves
`GET /zukhruf/v1/traces/:chatId` and `GET /zukhruf/v1/traces/:chatId/:traceId`
behind the Zukhruf authentication boundary. Ownership comes from the
authenticated `userId`; the file URI is never exposed and the browser never
sends a user ID. Without the plugin, `/info` omits `traces` and the UI hides
every **Traces** link. Recording controls are honored and disabled payloads are
labelled as not recorded.

The UI is built for the `/devtool` base: `/devtool` and `/devtool/` load the
shell, assets load beneath `/devtool/assets/`, deep links such as
`/devtool/history/:userId/:chatId/traces/:traceId` receive the shell for
browser history, and `/devtool` redirects to `/devtool/history`. The
**Scheduled** view is present but remains a placeholder.
