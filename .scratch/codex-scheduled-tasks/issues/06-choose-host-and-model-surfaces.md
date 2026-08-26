# Choose host API and model-facing creation boundary

Type: grilling
Status: accepted
Blocked by: 01, 05

## Question

How do users and models create and manage standalone Scheduled Tasks without confusing them with the current same-conversation scheduling tools?

## Decision needed

Define host operations for create, list, edit, pause, resume, delete, run now, inspect runs, and open a Run Conversation. Decide whether models get a distinct host capability, whether creation is UI-only initially, and how names and descriptions communicate the domain boundary.

## Acceptance

- `CronCreate`, `CronList`, `CronDelete`, and `ScheduleWakeup` keep their existing semantics.
- A standalone Scheduled Task cannot be mistaken for a future turn in the current chat.
- Every host operation has authorization and ownership rules.
- The initial surface exposes only behavior supported by the runtime contract.

## Comments

The product may reuse pg-boss below the surface, but pg-boss does not supply the product API, authorization, lifecycle, or Scheduled inbox by itself.

## Resolution

The first surface is a reusable host package API for schedule CRUD, pause/resume/archive, Run now, run inspection/cancellation, and review state. HTTP, UI, and model-facing standalone tools wait for a concrete consumer. Existing model-facing conversation tools do not change.
