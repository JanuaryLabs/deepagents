# Define the Scheduled Run and conversation lifecycle

Type: grilling
Status: accepted
Blocked by: 01, 02

## Question

Which states describe execution truth, review state, retention, and archival for a Scheduled Run and its Run Conversation?

## Decision needed

Define transitions for dispatch, running, completion, failure, cancellation, attention or approval needs, review, and archival. Decide whether review state is orthogonal to execution outcome and which object owns summaries, errors, timestamps, and unread state.

## Acceptance

- Business execution outcome is not confused with inbox review status.
- Every transition has one owner and durable timestamp.
- Recovery from an interrupted host has a defined state transition.
- Run history can link to a retained or intentionally archived conversation.

## Comments

Codex uses review-oriented run states while the underlying turn separately reports completion or failure. A Zukhruf state model should make that distinction explicit rather than overloading one status field.

## Resolution

Execution uses dispatching, running, completed, failed, and cancelled states. Terminal runs enter an independent pending-review state and may later be reviewed or archived. Full output remains with the external execution system.
