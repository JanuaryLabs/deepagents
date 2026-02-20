# Agent GC Refactor Workflow

## On-demand

1. Detect refactor targets within changed scope (`base...head`).
2. Apply safe mechanical transformations.
3. Re-scan remaining targets.
4. Verify with:
   - `npx nx affected -t lint,test,build --base=<base> --head=<head>`
5. Emit report artifacts.

## Scheduled

1. Detect refactor targets across repository scope.
2. Apply safe mechanical transformations.
3. Re-scan remaining targets.
4. Verify with:
   - `npx nx run-many -t lint,test,build`
5. Emit report artifacts and one batch PR summary grouped by principle.

## Unresolved Items

- Keep unresolved findings in `report.json` and `report.md`.
- Include suggested extraction strategy for reuse findings.
- Include suggested boundary/typing remediation for non-mechanical cases.
