---
name: agent-gc-refactor
description: Perform recurring repository garbage-collection refactors for agent-generated code. Use when asked to run broad cleanup focused on architecture boundaries, shared utility reuse, and stronger typing, in on-demand or scheduled maintenance loops that produce a single batch PR summary.
---

# Agent GC Refactor

Run this skill to enforce golden principles continuously and prevent architectural drift.

## Workflow

1. Run `scripts/run.ts` in `on-demand` or `scheduled` mode.
2. Detect refactor targets across boundaries, reuse, and typing.
3. Apply safe mechanical refactors automatically.
4. Re-scan and keep unresolved manual items explicit.
5. Produce report artifacts under `artifacts/agent-gc-refactor/<timestamp>/`.
6. For scheduled runs, emit one batch PR summary grouped by principle.

## Commands

```bash
node .codex/skills/agent-gc-refactor/scripts/run.ts --mode on-demand --base origin/main --head HEAD --apply
node .codex/skills/agent-gc-refactor/scripts/run.ts --mode scheduled --apply
```

Optional flags:

- `--report-dir <path>`: custom report directory
- `--skip-verify`: skip Nx lint/test/build verification gates

## Notes

- `--apply` defaults to `true`.
- On-demand mode uses `nx affected` verification.
- Scheduled mode uses `nx run-many` verification.
- Reuse-level architectural extractions that cannot be proven mechanically remain unresolved follow-ups.

For principle and sequence details:

- `references/golden-principles.md`
- `references/workflow.md`
