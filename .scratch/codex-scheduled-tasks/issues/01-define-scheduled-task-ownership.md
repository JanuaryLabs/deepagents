# Define the Scheduled Task aggregate and ownership boundary

Type: grilling
Status: accepted
Blocked by: none

## Question

What belongs to a Scheduled Task, Scheduled Occurrence, Scheduled Run, and Run Conversation, and which host identity owns each object?

## Decision needed

Define the minimum durable aggregate and ownership keys, including user or tenant, project, schedule, occurrence, run, and conversation relationships. State which records survive deletion or archival and which identifiers are stable enough for idempotency and links from the run inbox.

## Acceptance

- Each object has one clear owner and lifecycle boundary.
- A run can always be traced to its schedule and fresh root conversation.
- The model-facing conversation scheduler remains a separate domain.![alt text](app://-/apps/vscode.png)
- Multi-tenant isolation requirements are explicit.

## Comments

This is the root decision for the map. Avoid an abstraction that combines host-owned Scheduled Tasks with conversation-owned asks merely because both use a clock.

## Resolution

The opaque authenticated owner ID owns schedules and runs. A schedule is archived rather than hard-deleted, so every retained run keeps its schedule and external-execution link. Conversation schedules remain a separate domain.
