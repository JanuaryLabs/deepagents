# Code copied inside the Zukhruf runtime

A child conversation's completion receipt is the activity a host reads to show that a sub-agent's turn ended: `{ id: completion:<streamId>, type: 'completion', outcome, at, actorPath, targetPath, streamId }`. Two places build it.

The shape is copied, not shared, because it has two places (strike 2). Shared code is extracted when a third place writes a receipt (backlog #6321). Until then, a fix in one copy is made in the other copy too, and the commit names both files.

## Copied with changes

**`src/zukhruf/control-plane/agent-status-projector.ts` `projectTerminal` → `src/zukhruf/runtime/turn-interruption.ts` `#admit`.**

- `projectTerminal` records a receipt for any terminal stream (`completed`, `failed`, `cancelled`) and reads the outcome from the stream; `#admit` writes only `cancelled`, for a queued child stream it has just moved to cancelled.
- `#admit` writes it inside the same admission as the cancel, so a crash after that admission cannot lose it (#6305); `projectTerminal` runs after a worker's turn ends.
