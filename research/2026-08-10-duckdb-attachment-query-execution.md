# DuckDB attachment query execution

## Conclusion

`ATTACH` registers a remote catalog; it does not copy the catalog's data into
DuckDB. Queries scan the source at execution time. DuckDB asks each connector
for the columns and source-local filters it can push down, receives batches of
rows, and performs every remaining operator in the DuckDB process.

For a PostgreSQL-to-BigQuery join, the join necessarily runs in DuckDB. Unless
a connector documents a matching pushdown, `GROUP BY`, `HAVING`, `ORDER BY`,
and `LIMIT` should also be assumed to run in DuckDB. A failed or unsupported
pushdown can therefore transfer every referenced row and column from a source.

## PostgreSQL

- Attached tables are read directly from PostgreSQL at query time. Copying is
  an explicit separate operation such as `CREATE TABLE ... AS`.
- The extension exposes experimental filter pushdown, enabled by default, and
  DuckDB can push required columns into the scan. It does not document general
  join, aggregate, or `HAVING` pushdown for ordinary attached-table queries.
- It is not stateless: the extension keeps an in-memory connection pool and a
  schema cache, and a parallel table scan may use several PostgreSQL
  connections.
- `postgres_query` can deliberately execute a supplied SQL string wholly in
  PostgreSQL, but the DeepAgents DuckDB policy rejects arbitrary table
  functions, so model-generated SQL cannot use that escape hatch.

Sources:

- [DuckDB PostgreSQL extension](https://duckdb.org/docs/current/core_extensions/postgres/overview)
- [PostgreSQL connection pool](https://duckdb.org/docs/current/core_extensions/postgres/connection_pool)
- [PostgreSQL scanner design and projection/filter pushdown](https://duckdb.org/2022/09/30/postgres-scanner)

## BigQuery

- BigQuery support is a community extension. Attached-table reads use the
  BigQuery Storage Read API rather than copying the project into DuckDB.
- Projection pushdown is supported. Filter pushdown is experimental and
  enabled by default.
- Aggregate pushdown is experimental and disabled by default. When enabled,
  selected aggregates and compatible `WHERE`/`GROUP BY` expressions can become
  a BigQuery query job.
- The aggregate pushdown explicitly does not cover joins, `HAVING`, top-level
  `ORDER BY`, top-level `LIMIT`, or general BigQuery subplans. Unsupported
  shapes fall back to a Storage API scan followed by local DuckDB execution.
- It is not stateless: attachment validates authentication, catalog metadata is
  loaded lazily and cached, and queries create Storage API read sessions or
  BigQuery jobs depending on the selected plan.
- `bigquery_query` can explicitly run GoogleSQL in BigQuery, but it is also an
  arbitrary table function rejected by the current DeepAgents DuckDB policy.

Sources:

- [DuckDB BigQuery community extension surface](https://duckdb.org/community_extensions/extensions/bigquery)
- [BigQuery extension repository and pushdown behavior](https://github.com/hafenkran/duckdb-bigquery)

## Product implication

DuckDB attachment is a federation path, not a universal replacement for
warehouse-native execution. It is useful for cross-source joins over selective
scans. For large source-local BigQuery analytics, the native BigQuery adapter
can remain substantially cheaper because BigQuery executes the full query and
returns only the result. `EXPLAIN` must be checked before relying on pushdown.
