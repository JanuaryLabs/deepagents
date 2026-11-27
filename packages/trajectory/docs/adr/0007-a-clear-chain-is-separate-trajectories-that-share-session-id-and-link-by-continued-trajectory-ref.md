# A /clear chain is separate trajectories that share session_id and link by continued_trajectory_ref

Status: proposed, for review (deepagents #6107).

## Context

A `/clear` gives the context a new session id and a new transcript. The new transcript names the old one in `{"type":"derived-from","sessions":[{"id":"<old>","via":"clear"}]}`, and subagents started before the clear keep the old id. agent-plugin housekeeping counts the session as the whole chain (its RULINGS:127).

ATIF v1.8 says `session_id` is run-scoped, so trajectories of one logical run MAY share it, and `continued_trajectory_ref` points from a trajectory to its continuation.

## Considered options

- **Merge the chain into one trajectory.** Rejected: step ids restart per document, and a hook reads only its own segment.
- **Keep each segment separate and leave the linking to callers.** Rejected: that is today's copied knowledge.
- **`store.chain(session)` returns the segments oldest first. Reading them sets one `session_id` (the first segment's id) on all of them and each segment's `continued_trajectory_ref` to the next transcript's path.** This option was selected.

## Consequences

- A reader of one segment sees `extra.claude_code.derived_from`.
- A reader of the whole session uses `chain()`.
