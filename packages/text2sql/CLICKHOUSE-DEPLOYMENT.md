# ClickHouse adapter

`@deepagents/text2sql/clickhouse` provides a client-independent ClickHouse
adapter. It uses ClickHouse itself to classify SQL and resolve physical
relations before either the consumer validator or the candidate query can run.

## Supported versions

The real-server behavior suite is pinned to:

- `25.8.28.1`, the minimum supported version and previous LTS line; and
- `26.6.1.1193`, the current stable line when this adapter was implemented.

ClickHouse identifies 25.8 as an LTS release in the official
[25.8 release material](https://clickhouse.com/blog/clickhouse-release-25-08),
and published the current [26.6 release](https://clickhouse.com/blog/clickhouse-release-26-06)
on July 3, 2026. Re-evaluate and extend the pinned matrix before changing this
range. The official [support policy](https://clickhouse.com/legal/support-services-policy)
defines the rolling stable and LTS support windows.

## Usage

The package does not depend on a ClickHouse client. Supply one raw query
callback and keep protocol-specific result handling outside the adapter:

```ts
import {
  ClickHouse,
  constraints,
  indexes,
  info,
  rowCount,
  tables,
  views,
} from '@deepagents/text2sql/clickhouse';

const query = async (sql: string) => {
  const result = await client.query({ query: sql, format: 'JSON' });
  return result.json();
};

const database = new ClickHouse({
  defaultDatabase: 'analytics',
  execute: query,
  // EXPLAIN QUERY TREE already performs server-side semantic validation.
  // Keep this hook for any additional application validation.
  validate: async () => undefined,
  grounding: [
    info(),
    tables({ filter: ['analytics.users', 'analytics.orders'] }),
    views(),
    rowCount(),
    constraints(),
    indexes(),
  ],
});
```

The raw callback must:

- return row objects as an array, `{ data: rows }`, or `{ rows }`;
- throw when ClickHouse reports an exception, including HTTP responses that
  carry an `exception` field with a successful HTTP status;
- select JSON as a client/protocol option (or HTTP `default_format`), not by
  appending `FORMAT JSON` to the SQL; and
- never call `database.execute()`, which would recurse through policy analysis.

`execute` is intentionally the same raw callback used for policy inspection,
grounding queries, and the final accepted SELECT.

## Required database role

Create a dedicated user with one dedicated role. Do not add direct grants or
additional default roles to this user.

```sql
CREATE ROLE deepagents_readonly;

GRANT SELECT ON analytics.* TO deepagents_readonly;

-- Required by SQL policy analysis to reject SQL, executable, and WASM UDFs.
GRANT SELECT ON system.functions TO deepagents_readonly;

-- Required only when indexes() grounding is configured.
GRANT SELECT ON system.data_skipping_indices TO deepagents_readonly;

ALTER ROLE deepagents_readonly SETTINGS
    readonly = 1,
    max_execution_time = 30,
    max_memory_usage = 2000000000,
    max_rows_to_read = 100000000,
    max_bytes_to_read = 5000000000,
    max_result_rows = 100000,
    max_threads = 4;

CREATE USER deepagents
IDENTIFIED WITH sha256_password BY 'replace-with-a-secret';

GRANT deepagents_readonly TO deepagents;
ALTER USER deepagents DEFAULT ROLE deepagents_readonly;
```

Use `readonly = 1`. The adapter checks the effective value together with
`currentDatabase()` on first use, caches that successful check, and fails closed
unless the callback returns exactly one valid row. Keep ClickHouse permissions
and resource settings in place: server-assisted analysis is an additional
boundary, not a replacement for RBAC.

ClickHouse's official
[agentic analytics guidance](https://clickhouse.com/blog/how-to-set-up-clickhouse-for-agentic-analytics)
recommends a SELECT-only role, `readonly = 1`, and workload limits. In
ClickHouse Cloud, use a read-only service for this workload as well. A read-only
service can still export data through table functions, so service isolation
does not replace the adapter checks.

Use ClickHouse row policies for tenant filtering. The adapter does not rewrite
arbitrary SQL and `EXPLAIN` output is not a mutable AST.

## Policy behavior

Both `validate()` and `execute()` independently run this sequence before a
candidate can reach the corresponding consumer callback:

1. verify effective `readonly = 1` and capture the effective database;
2. inspect `EXPLAIN AST` and require one SELECT root;
3. reject `INTO OUTFILE`, every table function, dictionary/Join-engine lookup
   functions, and every non-system UDF origin;
4. inspect `EXPLAIN QUERY TREE run_passes = 0` to retain unused CTEs;
5. inspect the analyzed query tree to validate and resolve physical names; and
6. compare the union of relations with grounded entities using exact,
   case-sensitive, database-qualified names.

Unknown response columns, AST nodes, query-tree nodes, relation shapes,
function origins, parse failures, multiple statements, and malformed SQL all
fail closed. Views and Distributed tables are authorized by the relation name
reported by ClickHouse and must be grounded explicitly.
Dictionary access through `dict*` and Join-engine access through `joinGet*` are
not supported because those functions do not expose their data source as a
normal relation.

The pinned allowlist includes ordinary SELECTs, CTEs, views, joins, subqueries,
unions, `ARRAY JOIN`, `PREWHERE`, grouping, `HAVING`, `LIMIT BY`, windows, and
`QUALIFY`. Unapproved structural features remain rejected. For example, the
current real-server fixtures deliberately fail closed on column transformers
such as `* EXCEPT` and `ORDER BY ... WITH FILL` query-tree nodes.

ClickHouse documents the AST and query-tree modes in its
[EXPLAIN reference](https://clickhouse.com/docs/sql-reference/statements/explain).
Because their textual diagnostics are not a stable parser API, extend an
allowlist only after capturing output on both pinned versions and adding a
public real-server behavior test.

## Grounding behavior

The subpath exports `info`, `tables`, `views`, `rowCount`, `constraints`, and
`indexes` grounding factories.

- `tables()` and `views()` read access-filtered `system.tables` and
  `system.columns` metadata.
- `constraints()` reports ClickHouse nullability, default expressions, and
  primary-key columns. ClickHouse primary keys organize data and do not imply
  uniqueness.
- `indexes()` reports primary-key and data-skipping indexes; it needs the
  explicit `system.data_skipping_indices` grant shown above.
- `rowCount()` executes `count()` against each grounded table. Configure it
  only when exact counts are worth the scan and retain the resource limits.
- ClickHouse does not expose conventional foreign-key relationships, so table
  traversal does not synthesize them.

Keep grounding limited to curated databases and tables. A broad SELECT grant
also broadens what schema metadata and physical relations can be authorized.

## Compatibility testing

The ClickHouse integration file uses only the public package subpath and starts
real Docker servers. With Docker available, it runs both pinned images by
default. Set `CLICKHOUSE_TEST_IMAGE` to one pinned image for a focused run.

Do not replace the policy tests with mocked EXPLAIN payloads. New ClickHouse
versions must prove their actual AST/query-tree shapes and security behavior
against a real server before being added to the supported matrix.
