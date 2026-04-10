## Context

`@deepagents/text2sql` currently stores a single `Adapter` instance on the `Text2Sql` class (`#config.adapter`). Every public method — `chat`, `toSql`, `index`, `toPairs` — reads from this one field. The adapter surfaces in four distinct execution paths:

1. **Introspection** (`index()`) — calls `adapter.introspect()` to produce `ContextFragment[]`, cached via `JsonCache` keyed by `'introspection-' + version`.
2. **SQL generation** (`toSql()`) — passes the adapter to the agent for `format()` and `validate()`.
3. **Result tools** (`chat()`) — the adapter is captured in a bash command closure (`sql run`, `sql validate`). The LLM agent invokes `sql run "SELECT ..."` and the adapter executes it.
4. **Pair generation** (`toPairs()`) — the adapter is injected into a user-supplied factory function.

Each `Adapter` subclass (Sqlite, Postgres, SqlServer, BigQuery, MySQL, Spreadsheet) accepts an `execute: ExecuteFunction` callback — adapters don't own connections, they delegate to injected functions. The abstract `Adapter` base provides scope checking, formatting, and grounding orchestration.

Real deployments split data across operational, warehouse, and LoB databases. Users need one `Text2Sql` session to reason over multiple databases without maintaining separate instances and manually stitching results.

## Goals / Non-Goals

**Goals:**

- Allow `Text2Sql` to accept multiple named adapters at construction time
- Make introspection connection-aware: each adapter's schema fragments are tagged with its connection name so the LLM can distinguish which tables belong to which database
- Allow the `sql run` / `sql validate` bash commands to target a specific connection by name
- Support single-connection deployments through a one-entry `connections` map — no separate compatibility API
- Per-adapter introspection caching keyed by connection name + version
- Break the existing API cleanly (no compatibility shims per AGENTS.md rules)

**Non-Goals:**

- Cross-database JOINs or federated queries — each query targets exactly one connection. The LLM can run multiple queries and compose results in-memory, but we don't generate cross-adapter SQL
- Connection pooling or lifecycle management — adapters already receive injected `execute` functions; the caller owns connection lifecycle
- Automatic connection routing based on table names — the LLM explicitly names the connection
- Dynamic adapter registration after construction

## Decisions

### D1: Named connection map in constructor

Replace `adapter: Adapter` with `connections: Record<string, Adapter>`.

**Why over alternatives:**

- `Map<string, Adapter>` is less ergonomic in config objects. A plain record lets callers write `{ sales: sqliteAdapter, warehouse: pgAdapter }`.
- An array of `{ name, adapter }` tuples adds unnecessary indirection.
- The connection name is the user-facing identifier the LLM uses in `sql run --connection <name>`.

Single-connection callers pass `{ default: adapter }`. This keeps the runtime model uniform and avoids a compatibility union around the old `adapter` key.

### D2: Connection-scoped introspection fragments

Each adapter's `introspect()` output is wrapped in a parent `ContextFragment` tagged with the connection name:

```
{ name: 'connection', data: { name: 'sales', children: [...schemaFragments] } }
```

This gives the LLM clear grouping: `<connection name="sales"><table .../>...</connection>`. The existing fragment builders (`table`, `column`, `relationship`, `dialectInfo`) remain unchanged — they're just nested under a connection wrapper.

**Why not flat fragments with a `connection` field on each:**

- Flat fragments would require modifying every fragment builder to accept an optional `connection` parameter, touching `@deepagents/context`.
- Wrapping is non-invasive — it uses the existing `ContextFragment` nesting that renderers already support.

### D3: Connection-aware bash `sql` command

Extend the `sql` bash subcommands to accept a `--connection <name>` flag:

```
sql run --connection sales "SELECT * FROM orders"
sql validate --connection warehouse "SELECT * FROM products"
```

When omitted, uses the `default` connection. When only one connection exists, it's always the default.

**Why a flag, not separate commands per connection:**

- `sql_sales run ...` / `sql_warehouse run ...` would require dynamically naming bash commands, complicating the command registry.
- A flag is standard CLI convention and keeps the tool description stable regardless of how many connections exist.

`createSqlCommand` changes from `(adapter, metaStore)` to `(adapters: Record<string, Adapter>, metaStore)`. The handler parses `--connection`, looks up the adapter, and delegates.

### D4: Per-adapter introspection caching

Change the cache key from `'introspection-' + version` to `'introspection-' + connectionName + '-' + version`.

Each connection gets its own `JsonCache<ContextFragment[]>` instance stored in a `Map<string, JsonCache>`. The `index()` method iterates all connections, introspects each (using cached results where available), wraps in connection fragments, and returns the merged array.

### D5: `toSql` receives connection context, not a single adapter

The agent-level `toSql` function currently uses the adapter only for `format()` and `validate()`. With multiple connections:

- The LLM's structured output schema gains an optional `connection` field alongside `sql`.
- After generation, we look up the named adapter and call `adapter.format()` + `adapter.validate()` on the correct one.
- If the LLM omits `connection` and there's only one adapter, use it. If multiple and omitted, validation fails with a clear error asking the model to specify the connection.

### D6: `toPairs` factory signature change

Change from `(adapter: Adapter) => T` to `(adapters: Record<string, Adapter>) => T`.

The factory receives the full connection map. Existing callers that work with a single adapter update to `(adapters) => new SqlExtractor(sqls, adapters.default, ...)`. This is a clean break per project rules.

## Risks / Trade-offs

**[Prompt bloat with many connections]** → Each connection's full schema is included in the prompt. With 3+ large databases, token usage could explode. Mitigation: callers can use grounding config (`filter`, `columns`) to limit schema per connection. Future work could add per-connection fragment budget.

**[LLM confusion about which connection to target]** → The model might pick the wrong connection or forget to specify one. Mitigation: clear connection labeling in fragments + instruction fragments that explain multi-connection behavior + validation that rejects ambiguous queries.

**[Cache invalidation across connections]** → If one connection's schema changes but version stays the same, stale cache is served. Mitigation: version should encode per-connection state. Document that `version` should change when any connection's schema changes, or callers should use per-connection versions.

**[Breaking change scope]** → Constructor, `toPairs`, and `ResultToolsOptions` all change shape. Mitigation: this is early development with no users (per AGENTS.md), so clean breaks are preferred over shims.

## Open Questions

1. Should `version` be per-connection or global? Per-connection is more precise but more config. Global is simpler but risks stale caches.
2. Should the default connection name be `"default"` or should we infer it when only one connection is provided (i.e., any string key works as default when it's the sole entry)?
3. For `toSql`, should we support generating queries for multiple connections in a single call (e.g., "get sales from DB1 and inventory from DB2"), or strictly one query per call?
