# Choose occurrence identity and delivery guarantee

Type: grilling
Status: accepted
Blocked by: 01

## Question

What durable identity represents one intended occurrence, and what guarantee does the product make across retries, crashes, and restarts?

## Decision needed

Choose deterministic or generated occurrence identity, the order of cursor advancement and run creation, retry ownership, idempotency boundaries, and the user-visible promise: at-most-once, at-least-once with deduplication, or another explicitly named contract.

## Acceptance

- A crash at every handoff has a defined recovery result.
- Duplicate launch and lost-occurrence windows are addressed explicitly.
- Schedule advancement cannot silently imply successful execution.
- The contract is testable through public package and host boundaries.

## Comments

The installed Codex reference advances its schedule cursor before launching the new conversation, leaving a loss window if launch fails. Treat that as research evidence, not a behavior to copy automatically.

## Resolution

An occurrence is `(scheduleId, scheduledFor)`. Product writes and the next pg-boss job commit atomically. Jobs are at-least-once; the run ID deduplicates launch through a required idempotent host adapter.
