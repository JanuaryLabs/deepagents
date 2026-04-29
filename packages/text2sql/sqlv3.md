# Caller-Owned Sandbox

`Text2Sql` expects a caller-owned `sandbox: AgentSandbox`. `@deepagents/text2sql`
exposes a composable `SandboxExtension` that bundles the `sql` subcommand, its
transform plugins, and its arg-repair hook. Compose it through
`createRoutingSandbox({ hostExtensions: [...] })`, then wrap the routed backend
with `createBashTool()`.

## Default Path

```ts
import { InMemoryFs } from 'just-bash';

import {
  ContextEngine,
  createBashTool,
  createRoutingSandbox,
  createVirtualSandbox,
} from '@deepagents/context';
import { Text2Sql, sqlSandboxExtension } from '@deepagents/text2sql';

const sandbox = await createBashTool({
  sandbox: await createRoutingSandbox({
    backend: await createVirtualSandbox({ fs: new InMemoryFs() }),
    hostExtensions: [sqlSandboxExtension({ main: adapter })],
  }),
});

const text2sql = new Text2Sql({
  version: 'v3-demo',
  sandbox,
  adapters: { main: adapter },
  model,
  context: (...fragments) =>
    new ContextEngine({ store, chatId, userId }).set(...fragments),
});
```

The adapter-map key (`main` here) becomes the `<db>` selector in
`sql validate <db> "..."`, `sql run <db> "..."`, and `text2sql.toSql(input, '<db>')`.

## Composing With Your Own Extensions

`mergeExtensions` concatenates `commands` and `plugins`, chains
`onBeforeBashCall` hooks in order (each sees prior output), and merges `env`
with last-wins semantics.

```ts
import type { SandboxExtension } from '@deepagents/context';

const myExtension: SandboxExtension = {
  commands: [myCustomCommand],
  plugins: [myAuditPlugin],
  onBeforeBashCall: ({ command }) => ({ command: myRewrite(command) }),
  env: { MY_FLAG: '1' },
};

const sandbox = await createBashTool({
  sandbox: await createRoutingSandbox({
    backend: await createVirtualSandbox({ fs: new InMemoryFs() }),
    hostExtensions: [sqlSandboxExtension({ main: adapter }), myExtension],
  }),
});
```

## Low-Level Primitives

If `sqlSandboxExtension` does not fit your backend, the underlying pieces are
all exported: `createSqlCommand(adapters)`, `SqlBacktickRewritePlugin`,
`SqlProxyEnforcementPlugin`. Compose them directly into any sandbox backend
that accepts custom commands, transform plugins, and a pre-call hook.

## Config Shape

`Text2SqlConfig` fields:

| Field                               | Notes                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `adapters: Record<string, Adapter>` | Required. Keys match `/^[A-Za-z_][A-Za-z0-9_]*$/` and are used as the `<db>` argument in `sql run <db> "..."`. |
| `sandbox: AgentSandbox`             | Required                                                                                                       |
| `context`                           | Required                                                                                                       |
| `version`                           | Required                                                                                                       |
| `model`                             | Required                                                                                                       |
| `tools?: RenderingTools`            | Optional                                                                                                       |
| `transform?`                        | Optional                                                                                                       |

`filesystem` is not a `Text2Sql` constructor field — it belongs on the sandbox.

## File Event Behavior

When the sandbox filesystem is wrapped with `ObservedFs` and `drainFileEvents`
is exposed on the returned sandbox, file operations are observed and surfaced
as `metadata.fileEvents` on assistant messages produced by `chat()`. The
attachment is handled in `@deepagents/context` chat finalization via
`sandbox.drainFileEvents?.()`.

## Current Scope

- File event tracking is scoped to just-bash-based sandboxes.
- `sql` remains a bash subcommand interface (`sql validate <db> "..."`,
  `sql run <db> "..."`).

## Suggested Checks

- `node --test --no-warnings packages/text2sql/test/chat.integration.test.ts`
- `node --test --no-warnings packages/text2sql/test/file-events.integration.test.ts`
