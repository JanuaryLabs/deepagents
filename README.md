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
| `@deepagents/react-shadcn`     | Publish the shared Base UI-backed Shadcn primitive set and `cn()` helper.                                                      |

## Current Runtime Model

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
nx run context:typecheck
nx run text2sql:typecheck
nx run text2sql:test
nx run text2sql:build
```

Tests use the Node.js test runner under the Nx target. Import package modules
in tests, not relative source paths, so private class identities stay aligned
with built package output.

## Use a package's source from another repo

Each export of a package has a `@deepagents/source` condition first. This
condition points at the source in `src/`. The other conditions point at the
build in `dist/`. A repo that sets no condition gets `dist/`.

To change a package and a repo that uses it together, link the package. Then
run the other repo with the condition and with the text loader of this repo:

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
- `@deepagents/react-shadcn`: relative imports have no extension.
- `@deepagents/react-genai`, `@deepagents/react-input/browser` and
  `@deepagents/devtool-history`: the source is `.tsx`.

This repo does not set the condition in `customConditions`. The esbuild build
writes declarations with no project references, so it would compile the
source of each package that it imports.

Set the condition only while the package is linked. The published package has
no `src/`, so Node.js stops with `ERR_MODULE_NOT_FOUND`.
