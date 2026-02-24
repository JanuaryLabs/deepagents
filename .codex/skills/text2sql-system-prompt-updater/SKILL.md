---
name: text2sql-system-prompt-updater
description: Update the Text2SQL system prompt in a generalizable, non-overfit way using failure-pattern driven evaluation loops. Use when SQL generation quality regresses or specific failure classes repeat.
---

# Text2SQL System Prompt Updater

Use this skill when the task is to improve the SQL generation system prompt in:

- `packages/text2sql/src/lib/agents/sql.agent.ts`
- `packages/context/src/lib/fragments/*`

This skill is about prompt quality and policy design, not CLI ergonomics.

## Goal

Increase SQL correctness by adding or refining general prompt policies that improve behavior across many cases.

## Non-Negotiables

- Do not hardcode benchmark-specific hints in the prompt.
- Do not include table names, literal values, or question text from one failing case as examples.
- Do not change model-under-test unless explicitly requested.
- Do not remove existing product behavior or options.
- Prefer durable rules over one-off fixes.
- Prefer fragment-based policy updates over persona text edits.

## When Prompt Changes Are Appropriate

Prompt changes are appropriate when failures come from model behavior patterns, such as:

- false `unanswerable` decisions despite mappable schema
- unnecessary transformations (`strftime`, `substr`, derived columns)
- weak predicate choices (for example `IS NOT NULL` instead of explicit value)
- dropped join constraints or weaker query shape
- aggregation shape mismatches (`WHERE` vs `GROUP BY/HAVING`, superlative handling)
- unnecessary `DISTINCT`
- schema spelling normalization that breaks exact columns

## When Prompt Changes Are Not Appropriate

Do not patch prompt first when failures are caused by:

- broken eval or scorer infrastructure
- adapter validation bugs
- parser/runtime failures unrelated to query reasoning
- dataset or expected-output issues

Fix those at the correct layer first.

## Iteration Workflow

1. Baseline and scope

- Work in fixed-size ranges for large datasets and keep reruns scoped to previously failed records.
- Capture pass/fail counts and representative failures.

2. Cluster failures by behavior

- Group failures into reusable categories (mapping, aggregation, joins, literals, transformations, set ops).
- Avoid case-by-case prompt wording.

3. Write policy-level prompt updates

- Add concise rules that define behavior, not examples.
- Keep precedence clear: schema grounding first, then query-shape preferences, then fallback/error behavior.

4. Patch only prompt policy text

- Update reusable fragment policies `packages/context` fragment primitives.
- Avoid adding dataset-specific examples.

5. Rebuild and validate

- Re-run the same scoped range.
- Then rerun failed-only within that range until stable.
- Once a range stabilizes, move to the next range.

6. Regression check

- Re-test previously fixed ranges to confirm no backslide.

## Prompt Writing Rules

- Use explicit policy language: “Prefer…”, “Only when…”, “Do not…”.
- Keep rules short, concrete, and non-overlapping.
- Encode semantic flexibility generally (aliasing, lexical normalization), never with benchmark literals.
- Encode minimality: avoid extra columns, extra transforms, and speculative projections unless required.
- Encode strict schema fidelity: never hallucinate tables/columns, preserve exact column spelling.

## Recommended Policy Patterns

- Best-effort mapping before unanswerable:
  - “Do not return unanswerable if intent can be derived via filtering, joining, grouping, or set operations over existing schema.”
- Aggregation correctness:
  - “Use GROUP BY + HAVING for per-entity aggregate constraints.”
  - “For most/least by entity, prefer ORDER BY aggregate + LIMIT 1.”
- Set semantics:
  - “Use INTERSECT for shared members across both criteria.”
  - “Use UNION for either-of criteria when combining sets.”
- Predicate precision:
  - “Use exact equality for explicit values unless pattern matching is requested.”
- Minimal SQL:
  - “Avoid date parsing/substrings/derived projections unless explicitly requested or schema requires it.”

## Anti-Patterns

- benchmark-specific mapping examples in system prompt
- overfit lexical shortcuts tied to one dataset
- contradictory rules that cause output oscillation
- forcing wrong joins instead of schema-grounded best effort
- using persona text as the default location for every new behavior rule

## Definition of Done

- Target range reaches stable pass goals after failed-only reruns.
- No new regressions in previously passing ranges.
- Prompt diff is generalizable and free of benchmark-specific wording.
- A short summary maps each new rule to a failure category it addresses.
