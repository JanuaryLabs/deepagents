# DeepAgents

DeepAgents is a TypeScript workspace for building agent systems, context-aware
chat flows, local retrieval, and Text2SQL assistants.

## Packages

| Package                        | Purpose                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `@deepagents/agent`            | Compose AI agents with tools, handoffs, streaming, and structured output.                                                      |
| `@deepagents/compaction`       | Compact AI SDK conversation snapshots into bounded summaries with explicit budgets and provenance.                             |
| `@deepagents/context`          | Store, render, and resolve context fragments; persist chat history; run agent bash tools in virtual or Docker sandboxes.       |
| `@deepagents/elements`         | Define, validate, and serialize interactive-element catalogs shared by server runtimes and React renderers.                    |
| `@deepagents/evals`            | Run LLM evals with datasets, scorers, persistence, and reports.                                                                |
| `@deepagents/experimental`     | Ship unstable provider, reminder, and Zukhruf runtime surfaces before they graduate into stable packages.                      |
| `@deepagents/orchestrator`     | Prototype deep-research, deep-wiki, and plan-and-solve orchestration flows.                                                    |
| `@deepagents/retrieval`        | Ingest local files and external sources into a SQLite vector store for semantic search.                                        |
| `@deepagents/text2sql`         | Convert natural language to SQL, index database schemas, and run validated SQL through the package `sql` CLI inside a sandbox. |
| `@deepagents/toolbox`          | Provide reusable tools for web search, filesystems, containers, stocks, weather, and repo inspection.                          |
| `@deepagents/devtool`          | Serve the Zukhruf development UI and expose correlated trace recording through `@deepagents/devtool/traces`.                   |
| `@deepagents/devtool-history`  | Render the reusable DevTool history view for Zukhruf conversations.                                                            |
| `@deepagents/react-input`      | Provide the reusable structured prompt composer used by browser chat surfaces.                                                 |
| `@deepagents/react-formatters` | Format dates, durations, bytes, numbers, booleans, and generic display values for React UIs.                                   |
| `@deepagents/react-genai`      | Render AI SDK chat flows, trajectories, tools, citations, dynamic UI, and interactive responses.                               |

`@deepagents/react-genai` uses `@zukhruf/shadcn` primitives and `TheButton`
from `@zukhruf/ui`. In your app's Tailwind CSS v4 stylesheet, import both
packages' styles after Tailwind with plain `@import` statements, without
`layer()`:

```css
@import 'tailwindcss';
@import '@zukhruf/shadcn/styles.css';
@import '@zukhruf/ui/styles.css';
```

Import `TheButton` directly from `@zukhruf/ui`; `@deepagents/react-genai`
no longer re-exports it.

## React and AI SDK compatibility

`@deepagents/react-genai`, `@deepagents/react-input`, and
`@deepagents/devtool-history` declare React `^19.2.8` as a peer dependency:
19.2.8 or later within React 19. `@deepagents/react-genai` also requires
`react-dom` in the same range.

`@deepagents/react-genai` declares `ai@^7.0.153` and
`@ai-sdk/react@^4.0.157` as dependencies. DevTool declares
`@ai-sdk/otel@^1.0.153`. These ranges allow dependency updates within each
package's major version.

## React chat lifecycle

`AgentProvider` from `@deepagents/react-genai` uses the AI SDK's `useChat`
for chat state and stream reconnection. `initialMessages` seeds each new
`chatId`; use `useAgent().setChat(messages)` to replace loaded history.
Changing `chatId` or unmounting the provider stops its active stream.

Submissions queue by default and send in order when the chat is ready.
`useAgent().submit()` resolves when the message is queued or handed to the
chat, before the assistant finishes responding. A failed file upload rejects
that submission without sending it. Errors pause queued sends. A successful
`useAgentMessages().resumeStream()` lets the queue continue; an explicit
submission clears the current error and joins the end of the queue.

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

## Use a package's source from another repo

Each source-runnable package export has a `@deepagents/source` condition first.
This condition points at the source in `src/`. The other conditions point at
the build in `dist/`. `./package.json`, wildcard `./*` exports, and asset
exports such as `./styles.css` stay dist-only or asset-only. A repo that sets
no condition gets `dist/`.

To develop a package alongside a repo that consumes it, link the package.
Run the consuming repo with the condition and this repo's text loader:

```bash
npm link                                  # in packages/<package>
npm link @deepagents/<package>            # in the other repo
NODE_OPTIONS="--conditions=@deepagents/source --import <deepagents>/tools/src/text-loader.ts" node …
```

The source imports `.sql`, `.md` and `.txt` files as text. The build does
this with esbuild. Without the loader, Node.js stops with
`ERR_UNKNOWN_FILE_EXTENSION`.

Node.js cannot run some source files, so these exports need a bundler that
sets the condition, for example Vite with `resolve.conditions`:

- `@deepagents/retrieval` and `@deepagents/toolbox`: relative imports end in
  `.js`.
- `@deepagents/react-genai`, `@deepagents/react-input/browser` and
  `@deepagents/devtool-history`: the source is `.tsx`.

In the `tsconfig.json` of the other repo:

```json
{
  "compilerOptions": {
    "customConditions": ["@deepagents/source"],
    "allowImportingTsExtensions": true
  },
  "include": ["src", "<deepagents>/global.d.ts"]
}
```

TypeScript then checks the source of the package with the options of the
other repo. The source imports its own files with the `.ts` extension, so the
other repo needs `allowImportingTsExtensions`. If the other repo emits
JavaScript, use `rewriteRelativeImportExtensions` instead. `global.d.ts`
declares the `.sql`, `.md` and `.txt` modules and `tiny-tfidf`, which the
source imports.

This repo does not set the condition in `customConditions`. The esbuild build
writes declarations with no project references, so it would compile the
source of each package that it imports.

Set the condition only while the package is linked. The published package has
no `src/`, so Node.js stops with `ERR_MODULE_NOT_FOUND`.
