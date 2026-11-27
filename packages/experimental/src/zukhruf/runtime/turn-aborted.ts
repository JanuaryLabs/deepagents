import {
  type ContextEngine,
  type MessageFragment,
  user,
} from '@deepagents/context';

import { ModelOnlyContentKind, contentKindMetadata } from './content-kind.ts';

/** Codex's `TurnAborted::INTERRUPTED_GUIDANCE` (`core/src/context/turn_aborted.rs`). */
const INTERRUPTED_GUIDANCE =
  'The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.';

/** The `<turn_aborted>` fragment Codex records after an interrupted turn. */
const TURN_ABORTED_MESSAGE = `<turn_aborted>\n${INTERRUPTED_GUIDANCE}\n</turn_aborted>`;

/**
 * The `<turn_aborted>` marker Codex's ContextualUser mode records after an
 * interrupt: a user message with the user-role guidance
 * (`core/src/tasks/mod.rs` `interrupted_turn_history_marker`). It is tagged
 * `generic.turn_aborted`, so the session read leaves it out.
 */
export function turnAbortedMessage(): MessageFragment {
  return user({
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text: TURN_ABORTED_MESSAGE }],
    metadata: contentKindMetadata(ModelOnlyContentKind.turnAborted),
  });
}

/** Records the `<turn_aborted>` marker after what the cancelled turn recorded. */
export async function recordTurnAborted(engine: ContextEngine): Promise<void> {
  engine.set(turnAbortedMessage());
  await engine.save({ branch: false });
}
