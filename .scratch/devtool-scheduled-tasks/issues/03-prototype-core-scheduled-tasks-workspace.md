# Prototype the core Scheduled Tasks workspace

Type: prototype
Status: resolved
Blocked by: 01

## Question

What focused Tasks, Inbox, run-detail, and conversation-navigation interaction
inside the existing Limerence-style DevTool shell makes task state, execution
state, review state, fresh versus existing conversation targets, lifecycle
actions, loading and error states, and optional capability absence clear without
introducing memory, notifications, generated summaries, or RRULE authoring?

## Answer

Status: resolved by an approved throwaway prototype.

Three structurally different workspaces were built on the real `/scheduled`
route inside the Limerence shell and reviewed in the browser: a review mailbox
(split list/detail), a console (tabs plus dense table plus drawer), and an
agenda (one scroll with inline expansion). The user rejected all three and
supplied a reference design, which is the approved shape:

- **Left pane** — one filtered, searchable list. A `Needs review N` tab holds
  the owner-wide pending-review inbox; `All / Active / Paused / Completed /
Archived` filter retained tasks. A `Create` control sits inline with the tabs.
- **Right pane** — a settings-style detail: status word, title, the prompt in a
  rounded card, then grouped label/value rows under `Details`, `Frequency`, and
  (for runs) `Conversation`, a run history list, and one trailing
  `Open chat ↗` action.
- **Header actions** — `⋯` (Run now, Archive, Delete), a pause/resume toggle,
  and close.

Three reference elements changed to stay inside the decided scope:

| Reference                    | Shipped                                                                                                          | Reason                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `Notifications` row          | removed                                                                                                          | Notifications are out of scope                                                |
| `Repeat: Weekdays ⌄` builder | `Repeat` (raw five-field cron) plus a read-only `Reads as` line rendered by the workspace `cronstrue` dependency | The first editor is cron plus IANA timezone; an RRULE builder is out of scope |
| `⋯ → Run now, Delete`        | `Run now, Archive, Delete` with `Delete` disabled until archived                                                 | Purge requires an archived task                                               |

`Needs review` is added because the reference has no inbox and an owner-wide
pending-review queue is required scope; it reuses the same two-pane shape, so
selecting a run swaps only the right pane.

Selection lives in the URL so browser navigation and deep links work:
`/scheduled/tasks`, `/scheduled/tasks/:taskId`,
`/scheduled/tasks/:taskId/runs/:runId`, `/scheduled/review`, and
`/scheduled/review/:runId`. Filter and search stay component state.

Loading renders skeletons per pane, capability absence removes the navigation
entry entirely, request failures render an inline unavailable message, and every
lifecycle rejection surfaces in one `Action failed` alert above the detail pane.
