# Text2SqlV3 (Experimental) — Caller-owned Sandbox

## What changes vs `Text2Sql` (v1)

Text2Sql v1 built a **second** just-bash sandbox inside
`createResultTools`. The caller's outer `AgentSandbox` was decorative — its
bash tool got shadowed by the inner one, and skills were re-mounted via
`MountableFs` onto the inner FS.

v3 removes that. The caller owns their sandbox end-to-end:

- wires `createSqlCommand(adapter)` onto their own `new Bash(...)`;
- registers `SqlBacktickRewritePlugin` and `SqlProxyEnforcementPlugin` on that
  `Bash`;
- calls `createBashTool({ sandbox: bashInstance, onBeforeBashCall: ... })`
  from `@deepagents/context`;
- hands the resulting `AgentSandbox` to `Text2SqlV3`.

`Text2SqlV3.chat()` passes that sandbox straight into `agent()` with no
wrapping, no tool-merging games, no parallel FS.

## API

```ts
import { Bash, InMemoryFs } from 'just-bash';

import { ContextEngine, createBashTool } from '@deepagents/context';
import {
  SqlBacktickRewritePlugin,
  SqlProxyEnforcementPlugin,
  Text2SqlV3,
  createSqlCommand,
} from '@deepagents/text2sql';

const { command: sqlCmd, repair: sqlRepair } = createSqlCommand(adapter);

const bashInstance = new Bash({
  fs: new InMemoryFs(),
  customCommands: [sqlCmd],
});
bashInstance.registerTransformPlugin(new SqlBacktickRewritePlugin());
bashInstance.registerTransformPlugin(new SqlProxyEnforcementPlugin());

const sandbox = await createBashTool({
  sandbox: bashInstance,
  onBeforeBashCall: ({ command }) => ({ command: sqlRepair(command) }),
});

const text2sql = new Text2SqlV3({
  version: 'v3-demo',
  sandbox,
  adapter,
  model,
  context: (...fragments) =>
    new ContextEngine({ store, chatId, userId }).set(...fragments),
});
```

## Config

`Text2SqlV3Config` = v1's config minus `filesystem: IFileSystem`.

| Field                    | Same as v1?                                                  |
| ------------------------ | ------------------------------------------------------------ |
| `adapter`                | yes                                                          |
| `sandbox: AgentSandbox`  | yes — but caller is expected to have sql cmd + plugins wired |
| `context`                | yes                                                          |
| `version`                | yes                                                          |
| `tools?: RenderingTools` | yes — merged unchanged (no inner-tool shadowing)             |
| `model`                  | yes                                                          |
| `transform?`             | yes                                                          |
| `filesystem`             | **removed** — v3 owns no FS                                  |

## `createdFiles` metadata

v1 populates the assistant message's `metadata.createdFiles` via `TrackedFs`
(intercepts every FS write). v3 has no FS, so it reads the bash tool's
hidden-meta channel instead: the `sql run` handler calls
`useBashMeta()?.setHidden({ resultPath: sqlPath })`, and
`Text2SqlV3.chat()`'s `onFinish` walks `result.steps[].toolResults[].output.meta`
to collect every `resultPath`. The assertion shape on the assistant message
is identical (`Array.isArray(metadata.createdFiles)`).

## Inherited for free (context package already provides)

- Required `reasoning` input on every bash call.
- Per-call meta scope (`runWithBashMeta`) + strip in `toModelOutput`.
- Sandbox-boundary catch for `BashException` — `SqlProxyViolationError`
  thrown from the transform plugin becomes a stderr/exit-1 `CommandResult`
  automatically.

## Non-goals

- No multi-adapter map (see `sqlv2.md`).
- `sql` stays a bash subcommand, not a first-class AI SDK tool.
- v1 `Text2Sql` is untouched and still works. Cutover is a follow-up PR.

## Suggested Checks

- `node --test --no-warnings packages/text2sql/test/sqlv3/chat.integration.test.ts`
- `node --test --no-warnings packages/text2sql/test/chat.integration.test.ts`
