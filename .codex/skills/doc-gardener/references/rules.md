# Doc Gardener Rules

## Scope

Primary scan targets:

- `apps/docs/app/docs/**/*.mdx`
- `apps/docs/app/docs/**/*.md`
- `packages/*/README.md`
- `AGENTS.md`
- `README.md`

## Drift Detection Rules

1. API drift

- Parse `packages/*/src/index.ts` exported symbols.
- Flag exported symbols missing from corresponding package docs + README corpus.

2. Behavior drift

- Run test gates and treat failing checks as behavior drift signals.
- Attach command evidence to findings.

3. Docs integrity

- Validate `meta.json` page entries point to existing docs files.
- Detect orphans in directories governed by `meta.json`.
- Detect broken relative links and broken internal anchors.

## Autofix Rules

Safe deterministic fixes only:

- Repair broken relative paths when a unique canonical target exists.
- Repair broken internal anchors when a clear heading slug match exists.
- Reconcile `meta.json` entries by removing missing pages and appending existing unlisted pages.

Do not auto-rewrite semantic product descriptions. Emit unresolved follow-up items instead.

## Output Contract

`report.json` and `report.md` MUST include:

- `runId`, `mode`, `base`, `head`
- `findings[]`, `fixesApplied[]`, `unresolved[]`, `evidence[]`
- `exitStatus`
