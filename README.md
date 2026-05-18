# DeepAgents

DeepAgents is a TypeScript workspace for building agent systems, context-aware
chat flows, local retrieval, and Text2SQL assistants.

## Packages

| Package                 | Purpose                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@deepagents/agent`     | Compose AI agents with tools, handoffs, streaming, and structured output.                                                           |
| `@deepagents/context`   | Store, render, and resolve context fragments; persist chat history; run agent bash tools in virtual, Docker, or Agent OS sandboxes. |
| `@deepagents/text2sql`  | Convert natural language to SQL, index database schemas, and run validated SQL through the package `sql` CLI inside a sandbox.      |
| `@deepagents/retrieval` | Ingest local files and external sources into a SQLite vector store for semantic search.                                             |
| `@deepagents/evals`     | Run LLM evals with datasets, scorers, persistence, and reports.                                                                     |

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
