# ClickHouse adapter design

This document records the decisions and evidence gathered while designing
ClickHouse support for `@deepagents/text2sql`. It is an implementation handoff,
not a statement that the adapter already exists.

## Decision

Use ClickHouse server-assisted SQL policy analysis. Do not add a ClickHouse
fallback to `node-sql-parser`, and do not treat ClickHouse's textual `EXPLAIN`
output as a mutable local AST.

The public adapter will live at `@deepagents/text2sql/clickhouse`, accept
consumer-provided query callbacks like the existing adapters, and inject a
required `ClickHouseSqlPolicyAnalyzer` into `Adapter`.

The security boundary has three independent layers:

1. ClickHouse permissions and `readonly = 1` prevent database mutation.
2. Server-assisted policy analysis permits only grounded `SELECT` queries and
   rejects unsafe read capabilities.
3. Resource settings limit the availability impact of expensive reads.

No parser check replaces database permissions.

## Why server-assisted analysis

The parser spike produced the following results. Package ages, versions, sizes,
and maintainer counts are snapshots from the spike and must be refreshed before
using one of these packages for another purpose.

| Candidate                                 | Finding                                                                                                                                                                                                                                                   | Decision                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `node-sql-parser` using its MySQL dialect | Failed `PREWHERE`, `LIMIT BY`, `SAMPLE`, `SETTINGS`, typed parameters, and table functions; misread `ARRAY JOIN`.                                                                                                                                         | Reject for ClickHouse.                                                |
| `sqlparser-rs-wasm`                       | Had no ClickHouse dialect, was last published in 2022 at spike time, and failed core ClickHouse clauses.                                                                                                                                                  | Reject.                                                               |
| `@polyglot-sql/sdk` 0.6.1                 | Had broad ClickHouse coverage, but accepted invalid SQL, dropped `INTO OUTFILE`, omitted table functions from `baseTables`, and misparsed parts of `GLOBAL JOIN`. It was also young, single-maintainer, and approximately 22.4 MB unpacked at spike time. | Promising tooling, but reject as an authorization-sensitive boundary. |
| `chdb`                                    | Used the real engine, but native packages unpacked to approximately 344–559 MB per platform.                                                                                                                                                              | Correct engine, impractical package cost.                             |
| ClickHouse `EXPLAIN`                      | Correctly classified statements, rejected multiple statements, and exposed table functions, CTEs, joins, subqueries, and unions in the spike.                                                                                                             | Choose.                                                               |

Relevant references for the Polyglot snapshot are its
[source](https://github.com/tobilg/polyglot) and
[npm package](https://www.npmjs.com/package/@polyglot-sql/sdk).

## Existing policy boundary

`Adapter` requires a `SqlPolicyAnalyzer`; there is no optional analyzer and no
formatter-language default. Both `validate()` and `execute()` invoke the
analyzer before the consumer's database callback.

The current parser-backed adapters use one concrete class per dialect. Their
shared `node-sql-parser` mechanics are internal. ClickHouse must implement the
same asynchronous interface directly rather than inheriting the parser-backed
implementation.

```ts
export interface SqlPolicyAnalyzer {
  analyze(
    sql: string,
    context: SqlPolicyContext,
  ): Promise<SqlPolicyViolation | null>;
}
```

The analyzer receives grounded entities through `SqlPolicyContext` and returns
either `null`, a read-only violation, or a scope violation. It does not execute
the original query.

## Adapter API and OOP wiring

Follow the existing callback-owned adapter style. Do not force consumers to use
a particular ClickHouse client and do not add a ClickHouse client dependency to
this package.

```ts
export interface ClickHouseAdapterOptions {
  execute: ExecuteFunction;
  validate: ValidateFunction;
  grounding?: GroundingFn[];
  defaultDatabase?: string;
}

export class ClickHouse extends Adapter {
  constructor(options: ClickHouseAdapterOptions) {
    super(new ClickHouseSqlPolicyAnalyzer(options.execute));
    // Store the same raw callback for executeImpl/runQuery.
  }
}
```

Passing the raw consumer callback is important. Passing `adapter.execute()`
would recurse through policy analysis. The concrete analyzer owns ClickHouse's
server protocol; the abstract adapter only owns when policy runs.

The installed `sql-formatter` accepts `formatterLanguage = 'clickhouse'`, so no
formatter fallback is required.

## Analysis pipeline

Every unknown output shape, node type, or parse failure must fail closed.

```text
SQL
 |
 +-- effective readonly check (once, cached)
 |
 +-- EXPLAIN AST
 |    +-- require exactly one SelectWithUnionQuery
 |    +-- reject INTO OUTFILE
 |    +-- reject every table function
 |    +-- reject unknown structural nodes/output shapes
 |
 +-- EXPLAIN QUERY TREE run_passes = 0
 |    +-- retain strict syntactic coverage, including unused CTEs
 |    +-- collect relation identifiers and CTE aliases
 |    +-- reject TABLE_FUNCTION and unknown relation nodes
 |
 +-- fully analyzed EXPLAIN QUERY TREE
 |    +-- validate the query and resolve names
 |    +-- collect resolved physical tables
 |    +-- reject TABLE_FUNCTION and unknown relation nodes
 |
 +-- compare the union of syntactic and resolved physical relations
 |   against grounded scope
 |
 +-- adapter validator, then original SELECT execution
```

ClickHouse documents that `EXPLAIN AST` supports all query types, not only
`SELECT`, and that `EXPLAIN QUERY TREE` has an explicit `run_passes` setting.
See the official
[EXPLAIN documentation](https://clickhouse.com/docs/sql-reference/statements/explain).

### AST phase

Prefix the candidate SQL with `EXPLAIN AST` and parse the returned diagnostic
tree with a strict allowlist.

Requirements:

- Exactly one root statement must be present.
- The root must be `SelectWithUnionQuery`.
- `INTO OUTFILE` must be rejected.
- Every table function must be rejected in v1, not only known network or file
  functions.
- Multiple statements, mutation statements, malformed SQL, unknown nodes, and
  unknown response columns must be rejected.

The AST output is textual diagnostics, not a documented JSON parser API. Its
parser belongs inside `ClickHouseSqlPolicyAnalyzer` and must be pinned by live,
versioned fixtures.

### Query-tree phases

The spike found that the fully analyzed tree resolves physical names but can
remove unused CTEs. `run_passes = 0` retained every syntactic CTE, join,
subquery, and union reference. Therefore both views are required:

- The pre-pass tree preserves the package's strict syntactic-scope behavior.
- The analyzed tree validates semantics and provides resolved physical names.

The analyzer must compare all relations observed in either tree with the
grounded scope. CTE aliases and derived aliases are not physical relations.
Table functions or unfamiliar relation nodes in either tree are violations.

Case sensitivity, default-database qualification, dictionaries, and distributed
table resolution must be defined from real ClickHouse output and integration
fixtures rather than guessed locally.

## Mutation and exfiltration guarantees

Use a dedicated user with one dedicated SELECT-only role. The deployment must
ensure the user has no additional roles or direct grants.

```sql
CREATE ROLE deepagents_readonly;
GRANT SELECT ON analytics.* TO deepagents_readonly;

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

Use `readonly = 1`, not `2`. ClickHouse defines `1` as allowing read requests
and explicitly permitted setting changes. The adapter must verify the effective
`readonly` value through the raw query callback and reject the connection unless
it is `1`. Because the package has no asynchronous constructor lifecycle, the
analyzer should perform this as a cached, fail-closed first-use check.

For ClickHouse Cloud, prefer a read-only service in addition to the restricted
database user. This still does not permit table functions: ClickHouse notes that
a read-only service may export data through a table function. The official
[agentic analytics guidance](https://clickhouse.com/blog/how-to-set-up-clickhouse-for-agentic-analytics)
recommends SELECT grants, `readonly = 1`, and resource limits for LLM workloads.

Read-only does not mean harmless. A `SELECT` can reach files, URLs, S3, another
database, or a remote ClickHouse server through table functions. V1 therefore
rejects all table functions. Executable UDFs and other externally configured
functions must also be investigated and rejected when they can cross the data
boundary.

## SQL transformation is a separate concern

ClickHouse `EXPLAIN AST` is one-way inspection. Its textual output cannot be
passed to `node-sql-parser.sqlify()` and must not be presented as a mutable AST.

For existing supported dialects, `node-sql-parser` can parse, mutate, and render
SQL. The package already uses `astify()` followed by `sqlify()` for normalization
in `src/lib/synthesis/decorators/deduplicated-producer.ts`.

For ClickHouse:

- Use server settings for limits and availability protection.
- Use ClickHouse row policies for tenant filtering instead of injecting `WHERE`
  clauses into arbitrary SQL.
- Use a typed internal query representation when the application controls query
  construction.
- Arbitrary ClickHouse SQL rewriting requires a complete local parser and
  generator; server `EXPLAIN` cannot provide it.

## Integration and compatibility contract

The real-server suite is part of the implementation, not optional follow-up
work. It must use the public `@deepagents/text2sql/clickhouse` surface and the
runtime's built-in test runner.

Pin fixtures against:

- the minimum supported ClickHouse version; and
- the current supported ClickHouse version.

Required acceptance fixtures:

- simple tables and views;
- qualified and unqualified relations;
- CTEs, including unused CTEs;
- joins, subqueries, and unions;
- aliases and default-database resolution;
- grounded relations resolved by the analyzed query tree.

Required rejection fixtures:

- `INSERT`, `ALTER`, and other non-SELECT statements;
- multiple statements and malformed SQL;
- `INTO OUTFILE`;
- every table-function shape supported by the tested versions;
- unknown AST and query-tree output;
- out-of-scope relations inside CTEs, joins, subqueries, and unions;
- a connection whose effective `readonly` value is not `1`;
- resource-limit and permission fixtures where practical.

Both `validate()` and `execute()` must perform policy analysis independently.
Tests must also prove that a violation never reaches the consumer validator or
executor.

## Implementation sequence

1. Complete and verify the policy refactor:
   - keep `sql-policy.ts` as the required public contract;
   - keep parser mechanics internal;
   - keep concrete parser analyzers with their dialect adapters;
   - remove formatter-language-to-policy mapping;
   - keep ClickHouse out of the local parser dialect union.
2. Add the ClickHouse package subpath, adapter, grounding implementations, and
   `ClickHouseSqlPolicyAnalyzer` using the raw consumer callback.
3. Add the pinned real-server integration matrix and fail-closed textual-output
   fixtures.
4. Document the required database role, settings, grants, and Cloud service
   configuration in the public adapter README.

## Open implementation questions

These must be answered from live server output during implementation:

- Minimum supported ClickHouse version.
- Exact stable allowlists for AST and query-tree nodes across supported versions.
- Normalization rules for database-qualified names and identifier case.
- How views, dictionaries, distributed tables, and remote shards appear in both
  query-tree phases.
- How to identify executable UDFs or other externally configured functions
  without permitting an exfiltration path.
- Whether the callback needs a narrower typed result contract for `EXPLAIN`
  rows while preserving the client-independent adapter API.

Until these questions and their fixtures are resolved, unknown behavior fails
closed.
