# Define schedule configuration and execution context

Type: grilling
Status: accepted
Blocked by: 01

## Question

Which configuration is captured by the Scheduled Task, which is resolved at run time, and which settings may change between occurrences?

## Decision needed

Define the first-release fields for prompt, recurrence and timezone, project or workspace, local checkout or worktree isolation, model, reasoning effort, permissions, environment, notification preference, retention, and optional cross-run memory.

## Acceptance

- A run records the effective configuration it actually used.
- Timezone and daylight-saving behavior are explicit.
- Unattended permission behavior is safe and user-visible.
- Cross-run memory is opt-in and cannot accidentally inherit chat history.
- The first release avoids fields without a concrete consumer.

## Comments

Prefer a minimal host-owned configuration over mirroring every Codex option. Add a field only when the runtime or initial management surface needs it.

## Resolution

The schedule stores only prompt, RRULE/timezone, and opaque execution configuration. Each run snapshots those values. Repository, project, checkout, worktree, model, and permission meanings belong to concrete host adapters rather than the scheduler contract.
