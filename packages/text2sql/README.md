# @deepagents/text2sql

AI-powered natural language to SQL. Ask questions in plain English, get executable queries.

## Features

- **Natural Language to SQL** - Convert questions to validated, executable queries
- **Multi-Database Support** - PostgreSQL, SQLite, SQL Server, MySQL/MariaDB, and BigQuery adapters
- **Schema-Aware** - Automatic introspection of tables, relationships, indexes, and constraints
- **Domain Knowledge** - Inject business terms, guardrails, and query patterns via fragments
- **Conversational** - Multi-turn conversations with context persistence
- **Safe by Default** - Read-only queries, validation, and configurable guardrails

## Installation

```bash
npm install @deepagents/text2sql
```

Install the database driver or client library that matches your adapter:

```bash
npm install pg                       # PostgreSQL
npm install mssql                    # SQL Server
npm install mysql2                   # MySQL / MariaDB
npm install @google-cloud/bigquery   # BigQuery
```

Requires Node.js LTS

## Quick Start

```typescript
import { groq } from '@ai-sdk/groq';
import pg from 'pg';

import { Text2Sql } from '@deepagents/text2sql';
import {
  Postgres,
  columnValues,
  constraints,
  indexes,
  info,
  rowCount,
  tables,
  views,
} from '@deepagents/text2sql/postgres';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const adapter = new Postgres({
  execute: async (sql) => {
    const result = await pool.query(sql);
    return result.rows;
  },
  grounding: [
    tables(),
    views(),
    info(),
    indexes(),
    constraints(),
    rowCount(),
    columnValues(),
  ],
});

const text2sql = new Text2Sql({
  version: 'v1',
  model: groq('openai/gpt-oss-20b'),
  adapters: { main: adapter },
});

// Generate SQL
const sql = await text2sql.toSql(
  'Show me the top 10 customers by revenue',
  'main',
);
console.log(sql);
```

The adapter-map key (`main` here) is the adapter name. Reuse that same key in
`text2sql.toSql(..., 'main')` and in any `sql validate <db> "..."` /
`sql run <db> "..."` calls from a sandbox where the package CLI is installed.

Adapter names must match `/^[A-Za-z_][A-Za-z0-9_]*$/`. If you build adapter
maps dynamically, use `isValidAdapterName(name)` to check one key or
`validateAdapterNames(names)` to fail fast before constructing `Text2Sql` or
the sandbox-side adapter module used by the `sql` CLI.

## AI Model Providers

Text2SQL works with any model provider supported by the [Vercel AI SDK](https://sdk.vercel.ai/docs), including OpenAI, Anthropic, Google, Groq, and more.

## Building a Conversational Agent

`Text2Sql` owns SQL generation and schema indexing, but you own the chat loop.
Build the agent by composing a `ContextEngine`, a sandbox, and `agent` +
`chat` from `@deepagents/context`:

```typescript
import {
  ContextEngine,
  type ContextFragment,
  InMemoryContextStore,
  agent,
  chat,
  createContainerTool,
  errorRecoveryGuardrail,
  npm,
  user,
} from '@deepagents/context';
import { createSqlCommandHooks, instructions } from '@deepagents/text2sql';

const store = new InMemoryContextStore();
const context = new ContextEngine({
  store,
  chatId: 'chat-123',
  userId: 'user-456',
});

const sandbox = await createContainerTool({
  installers: [npm('@deepagents/text2sql', { ensureRuntime: true })],
  volumes: [
    {
      type: 'bind',
      hostPath: process.cwd(),
      containerPath: '/workspace',
      readOnly: true,
    },
  ],
  env: {
    TEXT2SQL_ADAPTERS: '/workspace/text2sql-adapters.ts',
  },
  ...createSqlCommandHooks({ adapters: { main: adapter } }),
});

const indexResult = await sandbox.sandbox.executeCommand('sql index');
if (indexResult.exitCode !== 0) throw new Error(indexResult.stderr);
const manifest = JSON.parse(indexResult.stdout) as { fragmentsPath: string };
const fragments = JSON.parse(
  await sandbox.sandbox.readFile(manifest.fragmentsPath),
) as ContextFragment[];
context.set(...instructions(), ...fragments);

const ai = agent({
  name: 'sql-assistant',
  sandbox,
  model: groq('openai/gpt-oss-20b'),
  context,
  guardrails: [errorRecoveryGuardrail],
  maxGuardrailRetries: 3,
});

await context.continue(user('Show me the top 10 customers by revenue'));
const stream = await chat(ai);

for await (const chunk of stream) {
  // handle streaming response
}
```

The `/workspace/text2sql-adapters.ts` module must exist in the sandbox and
default-export your adapter map. Mount your project into `/workspace` (as above)
or upload/write that module before you call `sql index` or `chat()`.

`instructions()` returns the SQL-flavored system fragments (policies, workflows,
clarifications, style guides) — spread them into `context.set()` alongside the
schema fragments returned by `sql index`. Add or replace them with your
own domain fragments as needed.

## Advanced: SQL CLI in Sandboxes

`sql validate <db> "..."` and `sql run <db> "..."` are real commands from the
`@deepagents/text2sql` package. `sql index` writes schema fragments plus
progress events for chat setup, indexing all configured adapters by default
(same as `--all`) unless adapter names are provided.

Install the package inside the sandbox and set `TEXT2SQL_ADAPTERS` to a module
whose default export is `Record<string, Adapter>`. Missing `sql` means the
sandbox was not prepared correctly.

`sql index` output details:

- `stdout`: JSON manifest with `fragmentsPath`, `eventsPath`, adapters, and
  fragment count.
- `--verbose pretty` or `--verbose json`: mirrors progress events to `stderr`
  while keeping `stdout` as the manifest.
- `--out-dir <path>`: writes artifacts under that path (default:
  `$TEXT2SQL_OUT_DIR` or `./sql`).

Set `TEXT2SQL_INDEX_VERSION` to manage cache invalidation across runs. Cache
keys are `index-<version>-<adapter>`, so bump the version when schema changes.

Spread `createSqlCommandHooks({ adapters })` into `createBashTool()` or
`createContainerTool()` for model-driven bash calls. The before hook preserves
the old virtual-command tolerance for common LLM quote mistakes, rewrites SQL
identifier backticks so bash does not run them as command substitutions, and
blocks raw database access so read-only and scope checks stay behind
`sql validate` / `sql run`. The after hook restores hidden `formattedSql`
metadata from the host adapter map without putting that concern into the real
CLI.

Read-only enforcement accepts a single `SELECT`/`WITH` statement even when it
starts with whitespace or SQL comments (`-- ...`, `/* ... */`). It still
rejects comment-only input, multi-statement batches, and write operations.

## Fragments

Inject domain knowledge by setting fragments on the `ContextEngine` you build
for the agent. Those fragments affect every `chat()` turn. If you need direct
SQL generation with extra fragments, use the lower-level `toSql({ fragments })`
helper exported from `@deepagents/text2sql`.

```typescript
import {
  ContextEngine,
  InMemoryContextStore,
  example,
  guardrail,
  hint,
  term,
} from '@deepagents/context';

const store = new InMemoryContextStore();
const context = new ContextEngine({
  store,
  chatId: 'chat-123',
  userId: 'user-456',
});

context.set(
  term('MRR', 'monthly recurring revenue'),
  hint('Always exclude test accounts with email ending in @test.com'),
  guardrail({
    rule: 'Never expose individual salaries',
    reason: 'Confidential HR data',
    action: 'Aggregate by department instead',
  }),
  example({
    question: 'show me churned customers',
    answer: `SELECT * FROM customers WHERE status = 'churned' ORDER BY churned_at DESC`,
  }),
);
```

**Domain fragments** (11 types): `term`, `hint`, `guardrail`, `example`, `explain`, `clarification`, `workflow`, `quirk`, `styleGuide`, `analogy`, `glossary`.

**User fragments** (5 types): `identity`, `persona`, `alias`, `preference`, `correction`.

See [@deepagents/context](../context/README.md) for full fragment documentation.

## Grounding

Control what schema metadata the AI receives:

| Function         | Description                                               |
| ---------------- | --------------------------------------------------------- |
| `tables()`       | Tables, columns, and primary keys                         |
| `views()`        | Database views                                            |
| `info()`         | Database version and info                                 |
| `indexes()`      | Index information for performance hints                   |
| `constraints()`  | Foreign keys and other constraints                        |
| `rowCount()`     | Table sizes (tiny, small, medium, large, huge)            |
| `columnStats()`  | Min/max/null distribution for columns                     |
| `columnValues()` | Enum-like and low-cardinality columns with sampled values |

## Conversations

`chat()` (from `@deepagents/context`) persists history through the
`ContextEngine` you build for the agent. Reuse the same store, `chatId`, and
`userId` to continue the same thread. Before each turn, append only the new
incoming message to the engine; do not replay earlier turns that are already
stored in the context store:

```typescript
await context.continue(user('Show me orders from last month'));
const stream = await chat(ai);

for await (const chunk of stream) {
  // handle streaming response
}

// Continue the same conversation
await context.continue(user('Now filter to only completed ones'));
const followUp = await chat(ai);
for await (const chunk of followUp) {
  // handle streaming response
}
```

## Streaming Index Progress

`AdapterIndexer#index({ onProgress })` emits progress events while it warms or reads
the schema cache for host-side indexing. The sandbox CLI writes the same event
shape to the `eventsPath` file returned by `sql index`:

```typescript
import { createUIMessageStream } from 'ai';

import {
  AdapterIndexer,
  TEXT2SQL_INDEX_PROGRESS_CHUNK,
  type Text2SqlIndexProgressEvent,
} from '@deepagents/text2sql';

const indexer = new AdapterIndexer({ adapters, version: 'v1' });

await context.continue(user('Show me top 10 customers'));

const stream = createUIMessageStream({
  execute: async ({ writer }) => {
    const head = await context.headMessage();
    if (!head || head.name !== 'assistant') {
      throw new Error(
        'expected head to be an assistant message — call context.continue() before chat()',
      );
    }
    writer.write({ type: 'start', messageId: head.id });

    const fragments = await indexer.index({
      onProgress: (event) =>
        writer.write({
          type: TEXT2SQL_INDEX_PROGRESS_CHUNK,
          data: event,
        }),
    });

    context.set(...instructions(), ...fragments);
    writer.merge(await chat(ai));
  },
});
```

Each progress event includes a generic Unix epoch `timestampMs` so clients can
calculate per-index, per-adapter, or per-phase durations without Text2SQL
imposing one duration policy.

`toSql()` is stateless. It reads the current schema fragments, but it does not
write messages, titles, or usage into your context store.

## Direct SQL Generation with Extra Fragments

This lower-level helper still takes a single `adapter` because it bypasses the
multi-adapter `Text2Sql` wrapper entirely.

```typescript
import { term } from '@deepagents/context';
import { toSql } from '@deepagents/text2sql';

const result = await toSql({
  input: 'Show ARR by plan',
  adapter,
  model: groq('openai/gpt-oss-20b'),
  fragments: [
    ...(await adapter.introspect()),
    term('ARR', 'annual recurring revenue'),
  ],
});

console.log(result.sql);
```

## Documentation

Full documentation available at [januarylabs.github.io/deepagents](https://januarylabs.github.io/deepagents/docs/text2sql):

- [Getting Started](https://januarylabs.github.io/deepagents/docs/text2sql/getting-started)
- [Generate SQL](https://januarylabs.github.io/deepagents/docs/text2sql/to-sql)
- [Agent + SQLite Store Recipe](https://januarylabs.github.io/deepagents/docs/text2sql/recipes/agent-sqlite-store)
- [Teach the System](https://januarylabs.github.io/deepagents/docs/text2sql/teach-the-system)
- [Build Conversations](https://januarylabs.github.io/deepagents/docs/text2sql/build-conversations)
- [Grounding](https://januarylabs.github.io/deepagents/docs/text2sql/grounding)
- [PostgreSQL](https://januarylabs.github.io/deepagents/docs/text2sql/postgresql)
- [SQLite](https://januarylabs.github.io/deepagents/docs/text2sql/sqlite)
- [SQL Server](https://januarylabs.github.io/deepagents/docs/text2sql/sqlserver)
- [MySQL / MariaDB](https://januarylabs.github.io/deepagents/docs/text2sql/mysql)
- [BigQuery](https://januarylabs.github.io/deepagents/docs/text2sql/bigquery)

## Repository

[github.com/JanuaryLabs/deepagents](https://github.com/JanuaryLabs/deepagents)
