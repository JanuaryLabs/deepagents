## ADDED Requirements

### Requirement: SQLite-backed storage

The run store SHALL use SQLite (via `node:sqlite`) for all persistence. The database file path SHALL be configurable, defaulting to `.evals/store.db` in the project root.

#### Scenario: Default database location

- **WHEN** the store is initialized without a custom path
- **THEN** the database is created at `.evals/store.db` relative to the working directory

#### Scenario: Custom database path

- **WHEN** the store is initialized with `path: '/tmp/my-evals.db'`
- **THEN** the database is created at that path

### Requirement: Suite management

The store SHALL support creating and querying suites. A suite groups related runs (e.g., same eval across different models). Suites are created explicitly by the caller — the engine does not auto-create them. Runs with `suite_id = null` are standalone (not part of any suite).

#### Scenario: Create a suite

- **WHEN** a suite is created with name `"text2sql accuracy 2026-02-22"`
- **THEN** it receives a unique ID and is persisted with the creation timestamp

#### Scenario: List suites

- **WHEN** user queries all suites
- **THEN** the store returns suites ordered by creation date descending

### Requirement: Run persistence

The store SHALL persist runs with: id, suite_id (nullable), name, model identifier, config JSON, started_at, finished_at, status (running/completed/failed), summary JSON.

#### Scenario: Save a completed run

- **WHEN** the engine completes a run and persists it
- **THEN** the store saves all run metadata and the run is queryable by id or suite_id

#### Scenario: List runs for a suite

- **WHEN** user queries runs for suite_id "abc"
- **THEN** the store returns all runs linked to that suite, ordered by started_at

### Requirement: Case persistence

The store SHALL persist individual cases with: id, run_id, index (position in dataset), input JSON, output text, expected JSON (nullable), latency_ms, tokens_in, tokens_out, error (nullable).

#### Scenario: Save case results

- **WHEN** the engine finishes scoring a case
- **THEN** the case data including input, output, expected, latency, and token counts is persisted

### Requirement: Score persistence

The store SHALL persist scores with: id, case_id, scorer_name, score (float 0..1), reason (nullable text).

#### Scenario: Multiple scorers per case

- **WHEN** a case is scored by 3 different scorers
- **THEN** 3 score rows are persisted, each with the scorer name and its score

### Requirement: Query failing cases

The store SHALL provide a method to retrieve cases where any scorer's score falls below a given threshold.

#### Scenario: Get failing cases

- **WHEN** user queries failing cases for run_id=1 with threshold=0.5
- **THEN** the store returns all cases that have at least one score below 0.5, including the failing scores and reasons

### Requirement: Run summary query

The store SHALL provide a method that computes aggregate statistics for a run: total cases, mean score per scorer, pass/fail counts at a threshold, total latency, total tokens.

#### Scenario: Compute run summary

- **WHEN** user queries summary for run_id=1
- **THEN** the store returns aggregated metrics computed from the cases and scores tables
