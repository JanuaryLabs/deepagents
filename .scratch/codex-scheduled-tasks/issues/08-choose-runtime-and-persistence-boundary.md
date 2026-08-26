# Choose runtime integration, persistence, and recovery boundary

Type: grilling
Status: accepted
Blocked by: 02, 03, 04, 05, 06

## Question

What is the smallest public Zukhruf and host boundary that launches a fresh root conversation durably without coupling the new domain to conversation scheduling internals?

## Decision needed

Trace and select the public runtime calls for root conversation creation and turn enqueueing, the schedule and run persistence owner, use or rejection of `WakeScheduler`, transaction and idempotency boundaries, startup recovery, concurrency control, and host callbacks for terminal run updates.

## Acceptance

- The design reuses an existing public primitive where it already fits.
- The host-owned schedule store is separate from conversation metadata.
- Restart behavior is defined for due, dispatching, running, and completed runs.
- No test-only export or internal side door is required.
- Integration coverage is specified through public package boundaries using real PostgreSQL where queue semantics matter.

## Comments

The likely execution path is Scheduled Task to Occurrence to persistent Run to new root Conversation to terminal Turn to Scheduled inbox. Verify that shape against the live runtime before implementation rather than treating it as an internal API mandate.

## Resolution

Product tables share PostgreSQL with pg-boss and use PGlite for the same local schema. A generic host adapter provides idempotent launch, inspect, and cancel; a Zukhruf conversation is one possible external execution, not the scheduler's built-in domain.
