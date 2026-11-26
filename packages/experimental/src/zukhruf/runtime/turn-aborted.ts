import { type ContextEngine, user } from '@deepagents/context';

/** Codex's `TurnAborted::INTERRUPTED_NEUTRAL_GUIDANCE` (`core/src/context/turn_aborted.rs`). */
const INTERRUPTED_NEUTRAL_GUIDANCE =
  'The previous turn was interrupted on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.';

/** The `<turn_aborted>` fragment Codex records after an interrupted turn. */
const TURN_ABORTED_MESSAGE = `<turn_aborted>\n${INTERRUPTED_NEUTRAL_GUIDANCE}\n</turn_aborted>`;

/**
 * Records the `<turn_aborted>` marker after a cancelled turn's partial output,
 * as Codex records it after an interrupt. Codex writes the multi-agent V2
 * variant as a developer message; the context has no developer role, so it
 * is a user message.
 */
export async function recordTurnAborted(engine: ContextEngine): Promise<void> {
  engine.set(user(TURN_ABORTED_MESSAGE));
  await engine.save({ branch: false });
}
