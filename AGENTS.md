### General Rules

- Early development, no users. No backwards compatibility concerns. Do things RIGHT: clean,
  organized, zero tech debt. Never create compatibility shims.

- WE NEVER WANT WORKAROUNDS. we always want FULL implementations that are long term
  suistainable for many >1000 users. so dont come up with half baked solutions

- Important: Do not remove, hide, or rename any existing features or UI options (even
  temporarily) unless I explicitly ask for it. If something isn’t fully wired yet, keep the UX
  surface intact and stub/annotate it instead of deleting it.

- Always ask more questions using AskUserQuestionTool until you have enough context to give an accurate & confident answer.

## Testing

- Focus on **integration tests** that test entire flows, not unit tests for individual functions.

### Running Tests

We write tests exclusively using Node.js test runner.

```sh
node --test path/to/package/test/file.test.ts
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

**Main Exports:** `agent`, `execute`, `swarm`, `instructions`, memory utilities, streaming utilities

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

To debug failing evals test cases

```bash
nx run text2sql:eval-debug --list
```

To run a specific eval test case

```bash
EVAL_INDEX=<test-case-index> nx run text2sql:eval path/to/eval.ts
```
