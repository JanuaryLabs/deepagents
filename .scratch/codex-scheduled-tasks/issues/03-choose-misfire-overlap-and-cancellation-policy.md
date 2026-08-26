# Choose misfire, overlap, and cancellation policy

Type: grilling
Status: accepted
Blocked by: 02

## Question

What happens when occurrences are missed, a prior run is still active, or the user pauses, edits, or deletes the Scheduled Task?

## Decision needed

Choose first-release policies for downtime catch-up, same-schedule overlap, concurrency limits, pause and resume, edit timing, deletion, canceling an active run, and queued-but-not-started occurrences.

## Acceptance

- Every collision has one deterministic outcome.
- The policy distinguishes canceling future occurrences from interrupting a running conversation.
- Resource conflicts in a shared checkout are covered.
- The user can predict what happens after host restart or prolonged downtime.

## Comments

Codex currently collapses missed repetitions to one catch-up and may run overlapping occurrences as separate conversations. Zukhruf must accept or reject those choices deliberately.

## Resolution

Downtime collapses to one catch-up, runs may overlap, and Run now leaves the recurrence cursor unchanged. Pause, edit, and archive affect future jobs only; explicit run cancellation is separate and closes the launch race through adapter cancellation.
