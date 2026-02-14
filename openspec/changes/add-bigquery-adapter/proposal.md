# Change: Add BigQuery Adapter for @deepagents/text2sql (Driver-Agnostic)

## Why

`@deepagents/text2sql` supports multiple SQL engines, but does not yet support Google BigQuery. BigQuery is a common analytics warehouse and a high-value target for natural-language-to-SQL.

## What Changes

- Add a new adapter module at `@deepagents/text2sql/bigquery`.
- Keep the adapter **driver-agnostic**: end users provide `execute(sql)` and **must** provide `validate(sql)` (recommended to implement validation via BigQuery dry-run).
- Add BigQuery groundings for:
  - `tables()` (with nested field paths)
  - `views()` (includes materialized views)
  - `info()`
  - `constraints()` (PK/FK/UNIQUE/CHECK + NOT NULL/DEFAULT when available via metadata)
  - `rowCount()` (**metadata-only**, no `COUNT(*)`)
  - `indexes()` (maps BigQuery clustering/partitioning metadata into index-like hints)
  - `report()` (optional, uses the generic LLM-driven report grounding; may be expensive depending on table sizes)
- **Explicitly not included in V1**: `columnStats()` and `columnValues()` groundings (data scans can be expensive in BigQuery).

## Impact

- Affected code:
  - `packages/text2sql/src/lib/adapters/*` (new `bigquery/` directory, package exports)
  - `apps/docs/app/docs/text2sql/*` (new BigQuery docs page + getting-started tabs update)
  - `packages/text2sql/src/lib/adapters/bigquery/*.test.ts` (integration tests)
