## Why

No standardized way to evaluate LLM outputs across the deepagents ecosystem. Existing setup (evalite) is a third-party dependency with limited control over storage, comparison, and integration. We need a general-purpose, research-focused framework that any LLM application can use — not just text2sql — with first-class support for model comparison, prompt iteration, and result persistence.

## What Changes

- **New package** `@deepagents/evals` replacing evalite dependency
- Dataset loading from local files (JSON/JSONL/CSV) or inline arrays with transform pipeline (map, filter, limit, shuffle, sample)
- Scorer system: deterministic scorers (exactMatch, includes, regex, levenshtein, jsonMatch) and LLM-as-judge scorers (llmJudge, factuality, sqlMatch) with user-configured judge model
- Composable scorers via `all()`, `any()`, `weighted()`
- Event-driven engine with concurrency control, per-case timeout, configurable trials (run N times + aggregate)
- SQLite run store with suite-linked runs for multi-model comparison (separate runs grouped by `suite_id`)
- Run comparison: per-case diff, aggregate score deltas, cost/token deltas, regression detection
- Console reporter subscribing to engine events
- Subpath exports: `/engine`, `/scorers`, `/store`, `/reporters`, `/comparison`, `/dataset`
- Top-level convenience function as main API entry point
- **BREAKING**: evalite removed as dependency from text2sql

## Capabilities

### New Capabilities

- `dataset`: Load, transform, and iterate over datasets from local files or inline arrays
- `scorers`: Score LLM outputs against expected results using deterministic or LLM-as-judge strategies, with composition (all/any/weighted)
- `engine`: Event-driven orchestrator handling concurrency, trials, timeouts, and variant execution
- `run-store`: SQLite-backed persistence for runs, cases, scores, and suites with query helpers
- `comparison`: Diff two runs case-by-case, detect regressions, compute aggregate and cost deltas
- `console-reporter`: Terminal output subscribing to engine events for progress, summaries, and failing case details

### Modified Capabilities

_(none — no existing specs)_

## Impact

- **New package**: `packages/evals` with subpath exports
- **Removed dependency**: evalite + autoevals removed from text2sql
- **Migration**: text2sql evals rewritten to use `@deepagents/evals` (same datasets, new API)
- **Dependencies**: `node:sqlite` for run store, `chalk` for console reporter, `@ai-sdk/*` for LLM-based scorers
- **Consumers**: Web runner (already exists) imports engine as library via subpath exports
