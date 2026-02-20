---
name: doc-gardener
description: Keep repository documentation accurate and agent-legible through drift detection and deterministic fixes. Use when asked to scan docs for stale content, broken links, metadata/nav drift, API coverage gaps, or to run recurring documentation gardening in on-demand or scheduled maintenance loops.
---

# Doc Gardener

Run this skill to maintain documentation integrity with deterministic checks and safe autofixes.

## Workflow

1. Run `scripts/run.ts` in `on-demand` or `scheduled` mode.
2. Detect API drift, behavior drift, and docs integrity issues.
3. Apply safe fixes for links, anchors, and `meta.json` page drift.
4. Produce machine-readable and human-readable reports under `artifacts/doc-gardener/<timestamp>/`.
5. For scheduled mode, include a single batch PR summary grouped by package/domain.

## Commands

```bash
node .codex/skills/doc-gardener/scripts/run.ts --mode on-demand --base origin/main --head HEAD --apply
node .codex/skills/doc-gardener/scripts/run.ts --mode scheduled --apply
```

Optional flags:

- `--report-dir <path>`: custom report directory
- `--skip-verify`: skip Nx lint/test/build verification gates

## Notes

- `--apply` defaults to `true`.
- On-demand mode uses `nx affected` gates.
- Scheduled mode uses `nx run-many` gates.
- Semantic/API narrative changes are left as unresolved follow-ups with evidence.

For detailed policy and sequence, read:

- `references/rules.md`
- `references/workflow.md`
