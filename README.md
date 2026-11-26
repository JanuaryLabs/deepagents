# DeepAgents

DeepAgents is a TypeScript workspace for building agent systems, context-aware
chat flows, and Text2SQL assistants.

## Packages

| Package                        | Purpose                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `@deepagents/agent`            | Compose AI agents with tools, handoffs, streaming, and structured output.                                                      |
| `@deepagents/compaction`       | Compact AI SDK conversation snapshots into bounded summaries with explicit budgets and provenance.                             |
| `@deepagents/context`          | Store, render, and resolve context fragments; persist chat history; run agent bash tools in virtual or Docker sandboxes.       |
| `@deepagents/elements`         | Define, validate, and serialize interactive-element catalogs shared by server runtimes and React renderers.                    |
| `@deepagents/evals`            | Run LLM evals with datasets, scorers, persistence, and reports.                                                                |
| `@deepagents/experimental`     | Ship unstable provider, reminder, and Zukhruf runtime surfaces before they graduate into stable packages.                      |
| `@deepagents/orchestrator`     | Prototype deep-research and plan-and-solve orchestration flows.                                                                |
| `@deepagents/text2sql`         | Convert natural language to SQL, index database schemas, and run validated SQL through the package `sql` CLI inside a sandbox. |
| `@deepagents/toolbox`          | Provide reusable tools for web search, filesystems, containers, stocks, weather, and repo inspection.                          |
| `@deepagents/devtool`          | Serve the Zukhruf development UI and expose correlated trace recording through `@deepagents/devtool/traces`.                   |
| `@deepagents/devtool-history`  | Render the reusable DevTool history view for Zukhruf conversations.                                                            |
| `@deepagents/react-input`      | Provide the reusable structured prompt composer used by browser chat surfaces.                                                 |
| `@deepagents/react-formatters` | Format dates, durations, bytes, numbers, booleans, and generic display values for React UIs.                                   |
| `@deepagents/react-genai`      | Render AI SDK chat flows, trajectories, tools, citations, dynamic UI, and interactive responses.                               |

`@deepagents/react-genai` needs the host to import stylesheets and give a
`ClockProvider`. See [its README](./packages/react/genai/README.md).

## React and AI SDK compatibility

`@deepagents/react-genai`, `@deepagents/react-input`, and
`@deepagents/devtool-history` declare React `^19.2.8` as a peer dependency:
19.2.8 or later within React 19. `@deepagents/react-genai` also requires
`react-dom` in the same range, and `@zukhruf/ui` as a peer dependency.

`@deepagents/react-genai` declares `ai@^7.0.153` and
`@ai-sdk/react@^4.0.157` as dependencies. DevTool declares
`@ai-sdk/otel@^1.0.153`. These ranges allow dependency updates within each
package's major version.

The message contexts are exported from `@deepagents/react-genai` as
`MessagesContext` and `MessageItemContext`. Update imports of `MessagesCtx` and
`MessageItemCtx` to these names; the old names are no longer exported.

## React chat lifecycle

`AgentProvider` from `@deepagents/react-genai` uses the AI SDK's `useChat`
for chat state and stream reconnection. `initialMessages` seeds each new
`chatId`; use `useAgent().setChat(messages)` to replace loaded history.
Changing `chatId` or unmounting the provider stops its active stream.

A submission made while a response is in flight waits in the AI SDK's queue,
`useAgentMessages().experimental_queuedMessages`, and the queued messages send
in order, one per finished response. `useAgent().submit()` resolves when the
message is queued or handed to the chat, before the assistant finishes
responding. A failed file upload rejects that submission without sending it.
A stop, an error or a network disconnect holds the queue, even after a
successful `useAgentMessages().resumeStream()`; the next submission clears the
current error, joins the end of the queue, and the held messages send first.
Label a queued message with `persistedPromptOf(message)`, the prompt as the
user typed it, and remove one with
`useAgentMessages().experimental_removeQueuedMessage(id)`.

Set `resume` to enable automatic stream resumption when opening an existing
conversation and when a page becomes visible after a network disconnect.
Use `useAgentMessages().resumeStream()` to reconnect manually.
`ZukhrufChatTransport` replays the response from the beginning; the AI SDK
replaces partial assistant output so replayed text is not duplicated.

`onData` receives streamed data parts, including transient parts that are
not stored in message history. `onFinish` can also run after an abort,
disconnect, or error; inspect its `isAbort`, `isDisconnect`, and `isError`
flags before treating the response as successful.

## Current runtime model

Text2SQL chat flows use a real sandbox-installed `sql` command. Install
`@deepagents/text2sql` inside the sandbox, point `TEXT2SQL_ADAPTERS` at an
adapter module, run `sql index` to produce schema fragments, then pass those
fragments with `instructions()` into the `ContextEngine`.

The context package no longer exposes the older routing/OpenAPI sandbox
extension layer. Use `createVirtualSandbox()` for just-bash custom commands,
`createDockerSandbox()` (chain with `createBashTool()` for the AI surface) for
real binaries, and `createSqlCommandHooks()` from Text2SQL when model-driven
bash calls need SQL quote repair, proxy blocking, and formatted-SQL metadata.

## Development

Use the Node.js LTS version selected by `.nvmrc` and its bundled npm:

```bash
nvm install
nvm use
npm ci
```

The root `.npmrc` allows directly declared URL dependencies so npm 12 can
install the workspace's SheetJS `xlsx` development dependency. The root
`package.json` lists allowed dependency install scripts in `allowScripts`.

`tsconfig.base.json` sets `erasableSyntaxOnly` so TypeScript rejects syntax
that Node.js cannot remove when running `.ts` files, such as enums and
constructor parameter properties.

Use Nx targets for package work:

```bash
nx run @deepagents/context:typecheck
nx run @deepagents/text2sql:typecheck
nx run @deepagents/text2sql:test
nx run @deepagents/text2sql:build
```

The Text2SQL test target uses the Node.js test runner. Import package modules
in tests, not relative source paths, so private class identities stay aligned
with built package output.

## Change a package and a repo that uses it

To change a package and a repo that uses it together, push the package to
`main`: the release workflow publishes it (see [MAINTAINERS.md](MAINTAINERS.md)).
Then install the published version in the other repo:

```bash
npm view @deepagents/<package> version         # the newest version on npm
npm install @deepagents/<package>@<version>    # in the other repo
```

Do not link the package into the other repo. A link runs code that no release
holds, and the other repo can get a second copy of a dependency that both repos
use. A published package holds only its `dist/` build.
