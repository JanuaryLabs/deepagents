# Choose implementation slices and acceptance gates

Type: grilling
Status: accepted
Blocked by: 03, 04, 05, 06, 07, 08

## Question

What dependency-ordered implementation slices and public-boundary proofs are sufficient to hand this map to coding work?

## Decision needed

Convert the accepted product and runtime decisions into the smallest sequence of schema, domain, coordinator, host API, UI, and recovery slices. Define red and green integration evidence, migration and restart checks, typecheck and test targets, and rollout gates for each slice.

## Acceptance

- Every slice delivers an independently testable behavior.
- Persistence and crash recovery land before management polish.
- The test matrix covers recurrence, restart, retry, overlap, cancellation, and fresh-conversation isolation.
- Verification uses `nx run <projectName>:typecheck` and `nx run <projectName>:test` through public package boundaries.
- Existing conversation-owned scheduling remains covered against regression.

## Comments

This ticket closes planning, not implementation. It should become concrete only after all upstream choices are accepted.

## Resolution

The dependency-ordered slices and verification gates are recorded in `map.md`. Each slice is proved through the public package boundary, with PGlite for fast integration and real PostgreSQL for transaction, concurrency, and crash semantics.
