# Text2Sql Multi-Adapter Support (sqlv2)

Users need to chat with 2+ databases simultaneously from a single Text2Sql instance.

## Design Decisions

| Decision | Choice |
|----------|--------|
| **Core use case** | Parallel independent queries, no cross-DB joins |
| **Instance model** | Single `Text2Sql` instance, named map of adapters |
| **API shape** | `adapters: Record<string, Adapter>` — no backwards compat shim |
| **Adapter map keys** | Validated as identifiers (alphanumeric + underscore), throw early on invalid |
| **LLM routing** | Namespaced positional arg: `sql run <db_name> "SELECT ..."` |
| **Schema presentation** | Parent fragment per adapter, nested hierarchy in context |
| **Guidelines** | Shared across all adapters, dialect info comes from adapter fragments |
| **Scope checking** | Per-adapter, self-contained, no cross-adapter awareness |
| **Result files** | Flat `/sql/{uuid}.json`, no change |
| **Caching** | Per-adapter `JsonCache`, keyed `${version}_${adapterName}` |
| **`createResultTools`** | Receives full adapters map, single `sql` command with internal routing |
| **SQL proxy enforcement** | Logic unchanged, update example text only |
| **`toSql` / `toPairs`** | Out of scope for this change |

## Files That Need Changes

| File | Change |
|------|--------|
| `sql.ts` | Constructor: `adapter` → `adapters` map. `index()`: iterate all adapters, per-adapter cache, wrap in parent fragments. `chat()`: pass map to `createResultTools` |
| `result-tools.ts` | `ResultToolsOptions`: `adapter` → `adapters` map. `createSqlCommand`: receives map, parses db name from args, routes to correct adapter. Usage strings updated |
| `sql-transform-plugins.ts` | Update `SQL_PROXY_ENFORCEMENT_MESSAGE` examples only |
| `instructions.ts` | Update `sql run`/`sql validate` examples to include `<db_name>` |
| `sql.agent.ts` | Out of scope (`toSql` unchanged) |
| `result-tools.test.ts` | ~150+ calls need `adapter` → `adapters` map update |
| `chat.integration.test.ts` | Constructor calls updated |
| `evals/` | Constructor calls updated |
| `apps/docs/` (13 MDX files) | All code examples updated |
| `README.md` | Quick start example updated |

## Key Design Rationale

- **No cross-DB joins:** Would require building a federated query engine — massive complexity for little gain. LLM can run separate queries and reason over combined results.
- **Named map over array:** Keys serve as identifiers in `sql run <db_name>` commands. LLM and user can reference databases by name.
- **No backwards compat:** Early development, no users, do things right.
- **Shared guidelines:** Guidelines are mostly dialect-agnostic. Dialect-specific details already come from each adapter's introspection fragments (dialectInfo).
- **Per-adapter caching:** Introspection is expensive (rowCount, columnStats). Adding a second adapter shouldn't force re-introspecting the first.
- **Single sql command with routing:** One tool definition in LLM context is simpler than N tools. Positional arg is more reliable for LLMs than flags.
