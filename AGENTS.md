### General Rules

- Always ask more questions using AskUserQuestionTool until you have enough context to give an accurate & confident answer.

- **Reproduce first.** For any bug fix — even with a pre-diagnosed root cause — reproduce the failure live (a throwaway scratchpad script against the real CLI/API/library) before writing the red test or the fix. Reproduction confirms the diagnosis, yields real fixture payloads for tests, and surfaces adjacent breaks the diagnosis missed.

## Testing

- Focus on **integration tests** that test entire flows, not unit tests for individual functions.
- **No test-only side doors to internal classes.** Never add package `imports` aliases, extra build entry points, or `internal.ts` re-exports so tests can construct something the public barrel deliberately hides. If a test can't reach behavior through the public surface, rewrite the test to drive the public API (e.g. `AgentRuntime.deliver`/`work`), not the internals — test as a user would use it.

### Running Tests

```sh
node --test --no-warnings  path/to/package/test/file.test.ts
```

### Test Import Rules

- **Always use package module specifiers** in test files, not relative source paths:

  ```typescript
  // ✅ CORRECT
  import { tables, Sqlite } from '@deepagents/text2sql/sqlite';

  // ❌ WRONG - causes type mismatches
  import { tables } from './index.ts';
  ```

- **Why**: TypeScript treats private class members (`#field`) as unique per class declaration. Mixing imports from built packages and source files creates two incompatible types.

## Package Overview

### @deepagents/agent (`packages/agent`)

A framework for building multi-agent AI systems with TypeScript. Create agents that use tools, coordinate through handoffs, and work together to solve complex tasks.

**Key Features:**

- **Agent Composition** - Build modular agents with specific roles and capabilities
- **Tool Integration** - Compatible with Vercel AI SDK tools
- **Handoffs** - Agents can delegate to specialized agents automatically
- **Structured Output** - Type-safe responses with Zod schemas
- **Streaming** - Real-time streaming responses
- **Context Sharing** - Type-safe state passed between agents

**Main Exports:** `agent`, `execute`, `swarm`, `instructions`, streaming utilities

### @deepagents/context (`packages/context`)

A domain-agnostic context management system for formatting context fragments into different prompt styles.

**Key Features:**

- **Multi-format Rendering** - XML, Markdown, TOML renderers for different LLM prompt styles
- **Context Store** - Persistent storage with SQLite and in-memory adapters
- **Skills Module** - Anthropic-style progressive disclosure with skills fragment
- **Token Estimation** - Estimate token usage across different models
- **Graph Visualization** - Visualize context graphs with branching and checkpoints

### @deepagents/text2sql (`packages/text2sql`)

AI-powered natural language to SQL. Ask questions in plain English, get executable queries.

**Key Features:**

- **Natural Language to SQL** - Convert questions to validated, executable queries
- **Multi-Database Support** - PostgreSQL, SQLite, and SQL Server adapters
- **Schema-Aware** - Automatic introspection of tables, relationships, indexes, and constraints
- **Teachables** - Inject domain knowledge via terms, hints, guardrails, examples, and more
- **Conversational** - Multi-turn conversations with history and user memory
- **Explainable** - Convert SQL back to plain English explanations
- **Safe by Default** - Read-only queries, validation, and configurable guardrails

**Teachable Types:** `term`, `hint`, `guardrail`, `example`, `explain`, `clarification`, `workflow`, `quirk`, `styleGuide`, `analogy`

### @deepagents/retrieval (`packages/retrieval`)

A local-first RAG (Retrieval-Augmented Generation) system that ingests content from various sources, creates vector embeddings, and provides intelligent document search.

**Key Features:**

- **Connector Pattern** - Ingest from GitHub, RSS feeds, local files, PDFs, Linear issues
- **Embedding** - FastEmbed for local embedding generation
- **Vector Storage** - SQLite-based vector store
- **Semantic Search** - Similarity search across ingested content
- **Chunking** - Markdown and recursive character text splitters

**Main Exports:** `ingest`, `similaritySearch`, `FastEmbed`, `SqliteStore`

---

### Building packages

To build a package, use the following command:

```sh
nx run <package-name>:build
```

For example, to build the `agent` package, run:

```sh
nx run agent:build
```

### Running Typescript files

We use node version that support running typescript files directly without precompilation. To run a typescript file, use the following command:

```sh
node path/to/file.ts
```

Always import files with extension. For example:

```ts
import { someFunction } from './some-file.ts';
```

Otherwise, node will throw an error.

### Running Evals

```bash
nx run text2sql:eval                    # Run all evals
nx run text2sql:eval path/to/eval.ts    # Run specific eval file
```
