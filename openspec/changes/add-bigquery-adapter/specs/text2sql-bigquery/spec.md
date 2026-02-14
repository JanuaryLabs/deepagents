# Capability: Text2SQL BigQuery Adapter (V1)

## ADDED Requirements

### Requirement: BigQuery Adapter Is Available Via Subpath Export

The system SHALL provide a BigQuery adapter module importable from `@deepagents/text2sql/bigquery`.

#### Scenario: Import Adapter And Groundings

- **WHEN** a developer imports from `@deepagents/text2sql/bigquery`
- **THEN** they can access `BigQuery` and the grounding factories `tables`, `views`, `info`, `constraints`, `rowCount`, `indexes`, and `report`.

### Requirement: Adapter Is Driver-Agnostic And Requires Validation

The BigQuery adapter SHALL be driver-agnostic and SHALL NOT bundle or require a specific BigQuery client library.

The BigQuery adapter constructor SHALL require the caller to provide:

- `execute(sql)` to run queries and return rows
- `validate(sql)` to validate SQL (recommended implementation uses BigQuery dry-run)

#### Scenario: Validation Is Missing

- **WHEN** a developer constructs the BigQuery adapter without a `validate` function
- **THEN** construction fails with an instructive error telling them to supply a dry-run validator.

### Requirement: Dataset Scoping

The BigQuery adapter SHALL accept an explicit list of datasets to introspect.

All schema introspection SHALL be restricted to that dataset list:

- Tables and views outside the configured datasets SHALL NOT be discovered
- Relationships (FKs) that reference tables outside the configured datasets SHALL NOT be traversed

#### Scenario: FK References Table In Unconfigured Dataset

- **GIVEN** a foreign key from `analytics.orders` to `other.users`
- **WHEN** the adapter is configured with datasets `['analytics']`
- **THEN** `other.users` is not introspected and the FK is not returned as a relationship fragment.

### Requirement: Table Names In Fragments

The BigQuery adapter SHALL represent table names in schema fragments as `dataset.table` (e.g., `analytics.orders`).

#### Scenario: Table Fragment Naming

- **WHEN** a table is discovered in dataset `analytics` with name `orders`
- **THEN** the resulting table fragment name is `analytics.orders`.

### Requirement: Nested Field Paths Are Flattened

The BigQuery adapter SHALL include BigQuery nested STRUCT field paths in the schema fragments as dot-delimited column names (e.g., `user.address.city`).

#### Scenario: STRUCT Field Path Column

- **GIVEN** a table column `user` with nested field `address.city`
- **WHEN** the schema is introspected
- **THEN** the table fragment includes a column named `user.address.city`.

### Requirement: Views Include Materialized Views

The BigQuery `views()` grounding SHALL include both logical views and materialized views.

#### Scenario: Discover View Types

- **WHEN** a dataset contains a logical view and a materialized view
- **THEN** both appear as `view` fragments after introspection.

### Requirement: Row Counts Are Metadata-Only

The BigQuery `rowCount()` grounding SHALL fetch row counts from BigQuery metadata only, and SHALL NOT compute row counts via `COUNT(*)`.

#### Scenario: Row Count Uses Metadata

- **WHEN** `rowCount()` is enabled
- **THEN** the grounding queries INFORMATION_SCHEMA metadata (e.g. storage metadata) and never issues `SELECT COUNT(*) FROM ...`.

### Requirement: Index Hints From Partitioning/Clustering

The BigQuery `indexes()` grounding SHALL map partitioning/clustering metadata into index-like hints and mark those columns as indexed to guide query planning.

#### Scenario: Clustering Columns Marked Indexed

- **GIVEN** a table clustered by columns `created_at`, `user_id`
- **WHEN** indexes grounding runs
- **THEN** those columns are marked `indexed: true` in the resulting schema fragments.

### Requirement: Constraints Are Best-Effort From Metadata

The BigQuery `constraints()` grounding SHALL collect constraints from metadata when available, including:

- PRIMARY KEY
- FOREIGN KEY
- UNIQUE
- CHECK
- NOT NULL (from column nullability)
- DEFAULT (from column default expression, if exposed)

#### Scenario: PK/FK Annotate Columns

- **GIVEN** a table with PK and FK constraints
- **WHEN** constraints grounding runs
- **THEN** resulting table fragments annotate `pk`, `fk`, and `notNull` on the appropriate column fragments.

### Requirement: No Column Stats / Column Values In V1

The BigQuery adapter module SHALL NOT export `columnStats()` or `columnValues()` groundings in V1.

#### Scenario: Consumer Attempts To Import Stats Grounding

- **WHEN** a developer attempts to import `columnStats` or `columnValues` from `@deepagents/text2sql/bigquery`
- **THEN** the import fails (not exported).
