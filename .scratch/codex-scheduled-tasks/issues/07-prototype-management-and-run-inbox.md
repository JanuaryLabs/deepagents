# Prototype Scheduled management and the run inbox

Type: prototype
Status: moved
Blocked by: 04, 05, 06

## Question

Can users understand the distinction between a Scheduled Task, its independent runs, and each run's fresh conversation from the management experience alone?

## Work

Build a disposable interaction prototype covering the Scheduled list, active and paused states, create and edit, run now, recent runs, status and unread indicators, and opening the conversation created for a run. Test the language with the user before production UI implementation.

## Acceptance

- The prototype visibly creates a new conversation for each run.
- It distinguishes execution result from review state.
- Pause, edit, delete, run-now, and active-run behavior match the accepted lifecycle decisions.
- Findings are recorded as product decisions, not shipped as production code.

## Comments

Do this only after the underlying lifecycle and configuration vocabulary is chosen; otherwise the prototype will invent the domain accidentally.

## Resolution

The concrete host is now `@deepagents/devtool`. The tracked
[`packages/devtool/plans/scheduled-tasks.md`](../../../packages/devtool/plans/scheduled-tasks.md)
plan owns the wireframes, HTTP boundary, run inbox, cross-run memory,
notifications, phases, and acceptance gates. This issue remains a historical
decision record rather than a second implementation tracker.
