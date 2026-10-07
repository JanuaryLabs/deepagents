# @deepagents/text2sql

AI-powered natural language to SQL. Ask questions in plain English, get executable queries.

## Features

- **Natural Language to SQL** - Convert questions to validated, executable queries
- **Multi-Database Support** - PostgreSQL, SQLite, DuckDB, SQL Server, MySQL/MariaDB, BigQuery, ClickHouse, and PostHog HogQL adapters
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
npm install @duckdb/node-api         # DuckDB
npm install @google-cloud/bigquery   # BigQuery
npm install @clickhouse/client       # ClickHouse, or use your preferred client
# PostHog uses native fetch and needs no additional client package
```

Requires Node.js LTS

## Quick Start

```typescript
import { groq } from '@ai-sdk/groq';
import pg from 'pg';

import { Text2Sql, toSql } from '@deepagents/text2sql';
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

const text2sql = new Text2Sql({ adapters: { main: adapter } });

const fragments = await text2sql.index({ names: ['main'] });
const { sql } = await toSql({
  input: 'Show me the top 10 customers by revenue',
  adapter,
  fragments,
  model: groq('openai/gpt-oss-20b'),
});
console.log(sql);
```

`index()` introspects the database schema and returns it as context fragments.
`toSql()` gives these fragments to the model and validates the SQL that the
model writes.

The adapter-map key (`main` here) is the adapter name. Reuse that same key in
`text2sql.index({ names: ['main'] })` and in any `sql validate <db> "..."` /
`sql run <db> "..."` calls from a sandbox where the package CLI is installed.
This is the configured connection name, not the SQL-level database or schema
name (for example, SQLite's default `main` schema).

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
  createBashTool,
  createDockerSandbox,
  errorRecoveryGuardrail,
  npm,
  user,
} from '@deepagents/context';
import {
  createSqlCommandHooks,
  instructions,
  sqlValidateReminder,
} from '@deepagents/text2sql';

const store = new InMemoryContextStore();
const context = new ContextEngine({
  store,
  chatId: 'chat-123',
  userId: 'user-456',
});

const backend = await createDockerSandbox({
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
});
const sandbox = await createBashTool({
  sandbox: backend,
  ...createSqlCommandHooks({ adapters: { main: adapter } }),
});

const indexResult = await sandbox.sandbox.executeCommand('sql index');
if (indexResult.exitCode !== 0) throw new Error(indexResult.stderr);
const manifest = JSON.parse(indexResult.stdout) as { fragmentsPath: string };
const fragments = JSON.parse(
  await sandbox.sandbox.readFile(manifest.fragmentsPath),
) as ContextFragment[];
context.set(...instructions(), ...fragments);
context.set(sqlValidateReminder());

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
schema fragments returned by `sql index`. The index output starts with an
`available_databases` fragment that lists the exact configured adapter names the
model must pass to `sql validate <db>` and `sql run <db>`. Add or replace the
instructions with your own domain fragments as needed.

`sqlValidateReminder()` returns a context reminder fragment backed by
`SQL_VALIDATE_REMINDER`. After a successful `sql run <db> "..."`, it adds a
model-only tool-output reminder before the next generation when no prior
`sql validate <db> "..."` used the same configured adapter name and exact SQL
text. The raw SQL command result remains unchanged. During streamed `chat()`
turns, the reminder is persisted as a synthetic user message for replay and
prompt caching; bare `createPrepareStep()` integrations and
`agent.generate()` own persistence of their generated assistant history.

## Advanced: SQL CLI in Sandboxes

`sql validate <db> "..."` and `sql run <db> "..."` are real commands from the
`@deepagents/text2sql` package. `<db>` is the configured adapter name. With a
single configured adapter, a mistaken database selector is routed to that sole
adapter and the command prints a note; with multiple adapters, unknown names
fail and print the available list. `sql index` writes an `available_databases`
fragment, schema fragments, and progress events for chat setup, indexing all
configured adapters by default (same as `--all`) unless adapter names are
provided.

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

The `sql` CLI caches introspected schema only when you opt in via env: set
`TEXT2SQL_INDEX_CACHE_DIR` (where cache files live) and/or
`TEXT2SQL_INDEX_VERSION` (an invalidation token — bump it when the schema
changes). With neither set, every `sql index` introspects fresh. See
[Schema index caching](#schema-index-caching) for
the underlying injectable primitives.

For in-process or virtual-sandbox usage (without installing the package CLI),
wrap an existing `Text2Sql` instance as a just-bash custom command:

```typescript
import { InMemoryFs, createVirtualSandbox } from '@deepagents/context';
import {
  type CreateSqlCommandOptions,
  type CreateSqlCommandResult,
  Text2Sql,
  createSqlCommand,
} from '@deepagents/text2sql';

const text2sql = new Text2Sql({ adapters: { main: adapter } });

const commandOptions: CreateSqlCommandOptions = {
  outputDir: '/sql-artifacts',
};
const sqlCommand: CreateSqlCommandResult = createSqlCommand(
  text2sql,
  commandOptions,
);

const sandbox = await createVirtualSandbox({
  fs: new InMemoryFs(),
  customCommands: [sqlCommand.command],
});

await sandbox.executeCommand('sql validate main "SELECT 1"');
```

`CreateSqlCommandOptions` configures command defaults (currently `outputDir`).
`CreateSqlCommandResult` returns the command plus a `repair(raw)` helper for
normalizing model-generated argv before execution.

Spread `createSqlCommandHooks({ adapters })` into `createBashTool()` for
model-driven bash calls. The before hook preserves
the old virtual-command tolerance for common LLM quote mistakes, rewrites SQL
identifier backticks so bash does not run them as command substitutions, and
blocks raw database access so read-only and scope checks stay behind
`sql validate` / `sql run`. The after hook restores hidden `formattedSql`
metadata from the host adapter map without putting that concern into the real
CLI.

Read-only enforcement parses a single `SELECT`/`WITH` statement even when it
starts with whitespace or SQL comments (`-- ...`, `/* ... */`). Before any
adapter validator or executor runs, the dialect policy rejects write
statements, multi-statement batches, parser failures, `SELECT INTO`, locking
reads/hints, assignments, known state/file/extension/remote-access functions,
BigQuery external queries, qualified BigQuery persistent routines, and
ClickHouse table functions or unsafe UDF origins.

Scope checks compare referenced base tables and views against the entities
produced by `tables()` and `views()` groundings. Entity-free queries such as
`SELECT 1` do not run grounding just to resolve an empty allowlist, and metadata
groundings such as `indexes()`, `constraints()`, `rowCount()`,
`columnStats()`, and `columnValues()` annotate schema context without expanding
the validation allowlist.

This parser policy is one safety layer, not a database permission boundary.
Static analysis cannot prove arbitrary unqualified user-defined functions are
side-effect free, and an otherwise valid `SELECT` can still consume excessive
CPU, memory, bytes, locks, or time. Production connections must use a dedicated
least-privilege identity with `SELECT` only on intended relations; disable or
withhold extension, file, remote-query, and routine execution capabilities; and
configure dialect-appropriate statement timeouts, byte/result limits, and
compute/memory limits.

The DuckDB adapter uses DuckDB's native JSON AST instead of the shared SQL
parser, so DuckDB-specific syntax is analyzed in its real grammar. It resolves
every referenced relation to a quoted `catalog.schema.table`, rejects writes,
multi-statement batches, side-effecting or user-defined functions and macros,
and arbitrary table functions, then compares those relations with the tables
and views produced by grounding. Production DuckDB connections must still be
read-only, disable external access and automatic/community extension loading,
set resource limits, and lock configuration after setup.

The PostHog adapter does not pass HogQL through the local SQL parser. It asks
PostHog to parse each query with `HogQLMetadata`, checks the returned base-table
names against grounded schema, and only then sends a `HogQLQuery` for execution.
Direct `adapter.execute(sql, values)` calls forward named HogQL values unchanged
after validation, which is useful for application-owned filters added outside
the model loop. Shell-escaped dollar-prefixed PostHog properties such as
`properties['\$device_type']` are decoded before validation and execution.

## Fragments

Inject domain knowledge by setting fragments on the `ContextEngine` you build
for the agent. Those fragments affect every `chat()` turn. For direct SQL
generation, give `toSql({ fragments })` the fragments from `index()` and your
own fragments.

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

## Schema index caching

Schema introspection is the expensive part of indexing. `Text2Sql` and
`AdapterIndexer` own no storage. You can give them a cache. The cache key is
the adapter name:

```typescript
export interface IndexCache {
  read(key: string): Promise<ContextFragment[] | null>;
  write(key: string, fragments: ContextFragment[]): Promise<void>;
}
```

- **No `cache`**: each `index()` call introspects the database.
- **A `cache`**: `index()` reads the cache first. On a miss, it introspects the
  database and writes the result to the cache.

The package ships a file-backed cache:

```typescript
import { FileIndexCache, Text2Sql } from '@deepagents/text2sql';

const text2sql = new Text2Sql({
  adapters: { main: adapter },
  cache: new FileIndexCache({ dir: '/var/cache/text2sql', namespace: 'v1' }),
});
```

`FileIndexCache` writes atomically (temp + rename). It treats a file that does
not parse to context fragments as a miss, so a torn read causes a new
introspection. `dir` defaults to the OS temp directory.

### Introspect once for concurrent callers

`index()` does not make callers wait for each other. When two callers miss the
cache at the same time, both introspect the database. The result stays
correct, because each write replaces the whole cache file.

To let only one caller introspect, acquire a key around `index()`. This example
uses [`@zukhruf/mutex`](https://www.npmjs.com/package/@zukhruf/mutex):

```typescript
import { Mutex, SqliteStore } from '@zukhruf/mutex';

const mutex = new Mutex(new SqliteStore('/var/lib/my-app/locks'));

const fragments = await mutex.acquire('text2sql:main', () =>
  text2sql.index({ names: ['main'] }),
);
```

The first caller introspects the database and writes the cache. The other
callers wait. When each waiter gets the key, its `index()` call reads the cache
that the first caller wrote.

`SqliteStore` shares keys between the processes on one host. For a fleet of
hosts, acquire the key from a service that all hosts share, for example a
Postgres advisory lock, and give all hosts the same cache.

> On object-storage-backed volumes (GCS/S3 FUSE) `rename` is not atomic. The
> `FileIndexCache` parse-as-miss behavior tolerates a torn write: the next
> `index()` call introspects again.

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

const indexer = new AdapterIndexer({ adapters });

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
- [DuckDB](https://januarylabs.github.io/deepagents/docs/text2sql/duckdb)
- [SQL Server](https://januarylabs.github.io/deepagents/docs/text2sql/sqlserver)
- [MySQL / MariaDB](https://januarylabs.github.io/deepagents/docs/text2sql/mysql)
- [BigQuery](https://januarylabs.github.io/deepagents/docs/text2sql/bigquery)
- [ClickHouse](https://januarylabs.github.io/deepagents/docs/text2sql/clickhouse)
- [PostHog](https://januarylabs.github.io/deepagents/docs/text2sql/posthog)

## Repository

[github.com/JanuaryLabs/deepagents](https://github.com/JanuaryLabs/deepagents)
