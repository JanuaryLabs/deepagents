# Doc Gardener Workflow

## On-demand

1. Detect drift for changed scope (`base...head`).
2. Apply deterministic fixes.
3. Re-scan integrity issues.
4. Run verification gate:
   - `npx nx affected -t lint,test,build --base=<base> --head=<head>`
5. Emit report artifacts.

## Scheduled

1. Detect drift across repository scope.
2. Apply deterministic fixes.
3. Re-scan integrity issues.
4. Run verification gate:
   - `npx nx run-many -t lint,test,build`
5. Emit report artifacts and single batch PR summary grouped by package/domain.

## Failure Handling

- Keep unresolved findings explicit.
- Keep evidence attached to each failure source.
- Return non-zero exit when unresolved or verification failure exists.
