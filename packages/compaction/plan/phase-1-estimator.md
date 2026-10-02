# Phase 1 — portable message estimates

Status: complete. Dependency: none. Next phase: [full-request budgets](./phase-2-request-budgets.md).

## Outcome

Standalone compaction works without a GPT-specific tokenizer. Existing trigger,
preservation, candidate validation, cancellation, and result behavior remain
intact. Read the [canonical contract](./README.md) before implementing.

## Owned files

- `packages/compaction/src/messages.ts`, `compact.ts`, `index.ts` as needed.
- `packages/compaction/src/compact.integration.test.ts`.
- `packages/compaction/package.json`, `project.json`, and the relevant lockfile
  entries only.
- The estimator/budget sections of `packages/compaction/README.md`.

## Work

1. Record `git status` and all current estimator/counter callers. Reproduce the
   existing universal GPT estimate through the public package API with two
   different conversation-model identities. Record that the default has no
   model input and therefore cannot select a model tokenizer; do not claim an
   accuracy percentage without provider measurements.
2. Replace the default with a deterministic character estimate:
   `Math.ceil(JSON.stringify(messages).length / 4)`, zero for an empty array.
   Keep it explicitly approximate and reuse the same conversion rule for the
   envelope in Phase 2. Add only the minimal shared function needed to avoid
   divergent rules; do not add an estimator service or model registry.
3. Retain `estimateTokens(messages)` and `countTokens(messages)` with their current
   public shapes. Keep finite, non-negative safe-integer validation for custom
   counter results and preserve cancellation checks around asynchronous counters.
4. Preserve unsupported-media/opaque-content behavior and safe boundaries. A
   character estimate does not make encoded media or encrypted provider state
   countable. The override remains available for those callers.
5. Remove the compaction package's direct `gpt-tokenizer` dependency and build
   external entry. Inspect every remaining workspace consumer before touching
   root/lockfile references; do not run a repository-wide dependency cleanup.
6. Update docs/JSDoc so target acceptance is explicitly based on the estimate.
   Do not restore the old below-target early return.

## Acceptance checks

- [x] A public `compact()` flow uses the new default, produces a valid summary,
      and rejects a candidate that exceeds the estimated message target.
- [x] A matched `messagesExceed(40)` still attempts reduction for 41 short messages
      already below the target; this is not an estimator eligibility check.
- [x] An explicit async counter still determines before/after counts and candidate
      acceptance, including a custom media counter.
- [x] Existing protected tools/approvals, latest-user replay, media preservation,
      empty/truncated/oversized summary, provider error, and abort checks pass.
- [x] A non-Latin/code-heavy fixture is exercised without asserting that the
      heuristic equals any provider's actual token count.
- [x] No `gpt-tokenizer` import/dependency remains in the compaction package.

Prefer extending the existing public integration flows over adding formula-only
unit suites. Read `TEST_PRIMITIVES.md`; do not expose package internals for tests.

## Verification

```sh
npx nx run @deepagents/compaction:typecheck
npx nx run @deepagents/compaction:test
```

The current package test target builds first and already sets a 10-second per-test
timeout. If a direct scratch `node --test` probe is needed, pass an explicit
`--test-timeout=<ms>` and import from `@deepagents/compaction`.

## Evidence and handoff

- Public ESM reproduction: the multilingual/code fixture counted 350 with the old
  GPT default versus 273 with the selected character estimate; no model parameter
  exists on the default estimator.
- Baseline: 21 public integration tests passed. New regression failed before the
  change (368 != 293), then all 22 passed after it. Nx typecheck passed.
- Removed the compaction import, dependency, and build external; retained the
  context package dependency because it remains a consumer (backlog #1958).
- Kept the media guard, async override and safe history boundaries. No public
  estimator abstraction or dependency was added. Skill self-audit: no new fallback
  or compatibility wrapper; the approximate default is explicitly user-approved.
- Logs for this execution: /tmp/compaction-phase1-{red,green,typecheck}.log.
- Next action: Phase 2, full prepared input accounting. No commit/staging performed.
